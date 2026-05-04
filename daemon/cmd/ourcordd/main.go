package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
	"tailscale.com/types/key"

	"github.com/ourcord/ourcord/daemon/pkg/control"
	ourderp "github.com/ourcord/ourcord/daemon/pkg/derp"
	ourice "github.com/ourcord/ourcord/daemon/pkg/ice"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	"github.com/ourcord/ourcord/daemon/pkg/routing"
	"github.com/ourcord/ourcord/daemon/pkg/tun"
	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

func main() {
	var (
		controlURL     = flag.String("control-url", "https://control.ourcord.app", "Control plane URL")
		socketPath     = flag.String("socket", ipc.DefaultSocketPath(), "Unix socket path for IPC")
		stateDir       = flag.String("state-dir", wg.DefaultStateDir(), "Persistent state directory (WireGuard private key, etc.)")
		logLevel       = flag.String("log-level", "info", "Log level: debug, info, error")
		wgListenPort   = flag.Int("wg-listen-port", 0, "Pin WireGuard UDP listen port (0 = ephemeral; set for smoke/manual mesh)")
		wgEndpointHint = flag.String("wg-endpoint", "", "Public host:port hint for our wg endpoint sent to control on register (empty = none)")
	)
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[ourcordd] ")

	_ = logLevel

	// Load (or generate-then-persist) the WireGuard identity. The key MUST be
	// stable across restarts: control plane allocates one VPN IP per public
	// key out of a finite pool, and peers cache the key in their WG configs.
	keyPath := filepath.Join(*stateDir, "wg.key")
	kp, err := wg.LoadOrCreateKeyPair(keyPath)
	if err != nil {
		log.Fatalf("Load WireGuard key (%s): %v", keyPath, err)
	}
	log.Printf("VPN public key: %s (state: %s)", kp.PublicKeyBase64(), keyPath)

	derpKeyPath := filepath.Join(*stateDir, "derp.key")
	derpKey, err := ourderp.LoadOrCreateNodeKey(derpKeyPath)
	if err != nil {
		log.Fatalf("Load DERP node key (%s): %v", derpKeyPath, err)
	}
	log.Printf("DERP node key: %s (state: %s)", derpKey.Public().String(), derpKeyPath)

	// Build daemon
	d := &daemon{
		controlURL:     *controlURL,
		keyPair:        kp,
		socketPath:     *socketPath,
		stateDir:       *stateDir,
		wgListenPort:   uint16(*wgListenPort),
		wgEndpointHint: *wgEndpointHint,
		derpKey:        derpKey,
	}

	// W3: load (or create) shared HMAC secret used by IPC clients (CLI, GUI)
	// to prove they have read access to the same file the daemon does. This
	// stacks on top of the SO_PEERCRED uid check.
	hmacKey, err := ipc.LoadOrCreateHMACKey(ipc.DefaultHMACKeyPath())
	if err != nil {
		log.Fatalf("Load IPC HMAC key: %v", err)
	}

	// IPC server
	ipcSrv := ipc.NewServer(*socketPath, d)
	ipcSrv.SetHMACSecret(hmacKey)
	if err := ipcSrv.Listen(); err != nil {
		log.Fatalf("IPC listen: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-quit
		log.Println("Shutting down...")
		cancel()
		ipcSrv.Close()
	}()

	log.Printf("IPC socket: %s", *socketPath)
	log.Printf("Control plane: %s", *controlURL)
	if conflicts := detectVPNSubnetConflicts(); len(conflicts) > 0 {
		for _, c := range conflicts {
			log.Printf("WARN: VPN pool 198.18.0.0/15 may conflict with existing route: %s", c)
		}
		log.Printf("WARN: tunnel will still come up (we install per-peer /32 routes only) but specific peer IPs may be unreachable if shadowed.")
	}
	log.Println("Daemon ready. Waiting for IPC commands.")

	if err := ipcSrv.Serve(ctx); err != nil {
		log.Printf("IPC server error: %v", err)
	}
}

// daemon implements ipc.Handler and coordinates VPN subsystems.
type daemon struct {
	controlURL     string
	keyPair        *wg.KeyPair
	socketPath     string
	stateDir       string
	wgListenPort   uint16 // 0 = ephemeral
	wgEndpointHint string // host:port, sent on register
	derpKey        key.NodePrivate

	vpnActive atomic.Bool

	connMu  sync.Mutex
	connCtx context.Context
	connCxl context.CancelFunc
	sigCxl  context.CancelFunc
	tunIf   tunIface
	table   *routing.Table
	cli     controlClient
	derpMgr *ourderp.Manager
	iceMgr  *ourice.Manager

	// assigned VPN addresses for status reporting (filled at connect, cleared
	// at disconnect).
	assignedIP4 string
	assignedIP6 string
	activeRoom  string

	// Injectable factories (test seam). nil → real implementations.
	newTun    func(name string, addrs []netip.Prefix) (tunIface, error)
	newClient func(controlURL, token, pubkey string) controlClient
}

// tunIface is the subset of *tun.Interface that connect()/meshLoop touches;
// kept small so tests can swap a fake without setting up an actual TUN device
// (which requires root and pollutes the host network).
type tunIface interface {
	Up() error
	Close() error
	ConfigureIPC(string) error
	GetIPC() (string, error)
	Name() string
	SyncPeerV4Routes([]netip.Addr) error
}

// controlClient is the subset of *control.Client that connect()/meshLoop
// touches. Tests stub this to point at an httptest.Server-backed shim.
type controlClient interface {
	Register(ctx context.Context, req control.RegisterRequest) (*control.RegisterResponse, error)
	FetchConfig(ctx context.Context, roomID string) (*control.PeerConfig, error)
	FetchSTUNServers(ctx context.Context) ([]string, error)
	Run(ctx context.Context, roomID string)
	SetSignalHandler(func(control.SignalMessage))
	InitiateHolePunch(ctx context.Context, targetKey string, offer control.ICEOffer) error
	SendICEAnswer(ctx context.Context, targetKey string, answer control.ICEOffer) error
	SendICECandidate(ctx context.Context, targetKey string, candidates []string) error
}

func (d *daemon) tunFactory() func(string, []netip.Prefix) (tunIface, error) {
	if d.newTun != nil {
		return d.newTun
	}
	return func(name string, addrs []netip.Prefix) (tunIface, error) {
		bind := conn.NewDefaultBind()
		if d.iceMgr != nil {
			bind = ourice.NewBind(bind, d.iceMgr)
		}
		if d.derpMgr != nil {
			bind = ourderp.NewHybridBind(bind, d.derpMgr)
		}
		return tun.NewWithBind(name, addrs, bind)
	}
}

func (d *daemon) clientFactory() func(string, string, string) controlClient {
	if d.newClient != nil {
		return d.newClient
	}
	return func(url, token, pub string) controlClient {
		return control.New(url, token, pub)
	}
}

func (d *daemon) HandleIPC(ctx context.Context, req ipc.IPCRequest) ipc.IPCResponse {
	switch req.Cmd {
	case ipc.CmdStatus:
		d.connMu.Lock()
		ip4, ip6, roomID := d.assignedIP4, d.assignedIP6, d.activeRoom
		var routes []*routing.PeerRoute
		if d.table != nil {
			routes = d.table.All()
		}
		d.connMu.Unlock()
		relayUsed, relayURL, pathSummary := summarizeRoutes(d.vpnActive.Load(), routes)
		return ipc.IPCResponse{
			OK: true,
			Data: ipc.DaemonStatus{
				Running:     true,
				VPNActive:   d.vpnActive.Load(),
				IP4:         ip4,
				IP6:         ip6,
				RoomID:      roomID,
				PeerCount:   len(routes),
				RelayUsed:   relayUsed,
				RelayURL:    relayURL,
				PathSummary: pathSummary,
			},
		}
	case ipc.CmdListPeers:
		d.connMu.Lock()
		var routes []*routing.PeerRoute
		if d.table != nil {
			routes = d.table.All()
		}
		d.connMu.Unlock()
		return ipc.IPCResponse{OK: true, Data: connectedPeers(routes)}
	case ipc.CmdConnect:
		if err := d.connect(ctx); err != nil {
			return ipc.IPCResponse{OK: false, Error: err.Error()}
		}
		return ipc.IPCResponse{OK: true}
	case ipc.CmdEnterRoom:
		roomID := strings.TrimSpace(req.Params["room_id"])
		if roomID == "" {
			return ipc.IPCResponse{OK: false, Error: "room_id required"}
		}
		if err := d.enterRoom(ctx, roomID); err != nil {
			return ipc.IPCResponse{OK: false, Error: err.Error()}
		}
		return ipc.IPCResponse{OK: true}
	case ipc.CmdLeaveRoom:
		if err := d.leaveRoom(ctx); err != nil {
			return ipc.IPCResponse{OK: false, Error: err.Error()}
		}
		return ipc.IPCResponse{OK: true}
	case ipc.CmdDisconnect:
		d.disconnect()
		return ipc.IPCResponse{OK: true}
	case ipc.CmdPing:
		return ipc.IPCResponse{OK: true, Data: map[string]string{"pong": "ok"}}
	default:
		return ipc.IPCResponse{OK: false, Error: fmt.Sprintf("unknown command: %s", req.Cmd)}
	}
}

func summarizeRoutes(active bool, routes []*routing.PeerRoute) (bool, string, string) {
	if !active {
		return false, "", "inactive"
	}
	if len(routes) == 0 {
		return false, "", "no-peers"
	}
	var hasWaiting, hasDirect, hasDERP, hasNextHop, hasUnresolved bool
	var relayURL string
	for _, r := range routes {
		path := routePath(r)
		switch path {
		case "waiting":
			hasWaiting = true
			if relayURL == "" {
				relayURL = r.DERPURL
			}
		case "direct":
			hasDirect = true
		case "derp":
			hasDERP = true
			if relayURL == "" {
				relayURL = r.DERPURL
			}
		case "next-hop":
			hasNextHop = true
		default:
			hasUnresolved = true
		}
	}
	if hasUnresolved {
		return hasDERP, relayURL, "degraded"
	}
	if hasWaiting {
		return false, relayURL, "waiting"
	}
	if hasDERP {
		return true, relayURL, "derp"
	}
	if hasNextHop {
		return false, "", "next-hop"
	}
	if hasDirect {
		return false, "", "direct"
	}
	return false, "", "degraded"
}

func connectedPeers(routes []*routing.PeerRoute) []ipc.ConnectedPeer {
	out := make([]ipc.ConnectedPeer, 0, len(routes))
	for _, r := range routes {
		path := routePath(r)
		peer := ipc.ConnectedPeer{
			PublicKey:    r.PublicKey.String(),
			Name:         r.Name,
			IP4:          addrString(r.VPN4),
			IP6:          addrString(r.VPN6),
			Direct:       path == "direct",
			Path:         path,
			RelayURL:     r.DERPURL,
			LatencyMs:    0,
			LastSeenSecs: r.LastSeen,
			LastError:    routeLastError(r, path),
		}
		if r.ICEPending || r.ICEReady {
			peer.Endpoint = "ice"
		}
		if r.NextHop != nil {
			peer.NextHop = r.NextHop.String()
		}
		out = append(out, peer)
	}
	return out
}

func routePath(r *routing.PeerRoute) string {
	if r == nil {
		return "unresolved"
	}
	if r.NextHop != nil {
		return "next-hop"
	}
	if r.ICEPending {
		return "waiting"
	}
	if r.ICEReady {
		return "direct"
	}
	if r.DERPURL != "" && r.DERPNodeKey != "" {
		return "derp"
	}
	if r.VPN4.IsValid() || r.VPN6.IsValid() {
		return "waiting"
	}
	if r.LastError != "" {
		return "unresolved"
	}
	return "unresolved"
}

func routeLastError(r *routing.PeerRoute, path string) string {
	if r == nil {
		return ""
	}
	if r.LastError != "" {
		return r.LastError
	}
	if path == "waiting" && !r.ICEPending && r.NextHop == nil && (r.DERPURL == "" || r.DERPNodeKey == "") {
		return "no-derp-route"
	}
	return ""
}

func addrString(a netip.Addr) string {
	if !a.IsValid() {
		return ""
	}
	return a.String()
}

// connect wires the daemon into the OurCord overlay (G1):
//  1. Read the auth token (env OURCORD_DAEMON_JWT or <state-dir>/token).
//  2. POST /api/peers/register → receive allocated VPN IPv4/IPv6.
//  3. tun.New() — kernel TUN + per-platform OS address assignment (W1/G14).
//  4. wireguard-go device.Up() with the registered private key.
//  5. Initial /api/peers/config fetch → routing.Table → device.IpcSet.
//  6. Background goroutines: control WS Run() (signaling for ICE) +
//     30s mesh poller (re-fetch /peers/config and apply diff).
//
// The daemon programs DERP first, then runs per-peer ICE over the room
// signaling channel. When ICE connects, the WireGuard endpoint is rewritten
// to ice:// for that peer; if ICE fails, the existing DERP endpoint keeps
// carrying packets.
func (d *daemon) connect(ctx context.Context) error {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	if d.vpnActive.Load() {
		return errors.New("VPN already active")
	}

	token, err := loadAuthToken(d.stateDir)
	if err != nil {
		return fmt.Errorf("load auth token: %w", err)
	}

	cli := d.clientFactory()(d.controlURL, token, d.keyPair.PublicKeyBase64())
	derpKey := d.derpKey
	if derpKey.IsZero() {
		loaded, err := ourderp.LoadOrCreateNodeKey(filepath.Join(d.stateDir, "derp.key"))
		if err != nil {
			return fmt.Errorf("load DERP node key: %w", err)
		}
		derpKey = loaded
		d.derpKey = loaded
	}
	derpMgr := ourderp.NewManager(derpKey, log.Printf)
	stunCtx, stunCancel := context.WithTimeout(ctx, 5*time.Second)
	stunServers, err := cli.FetchSTUNServers(stunCtx)
	stunCancel()
	if err != nil {
		log.Printf("fetch STUN servers: %v (continuing with host candidates only)", err)
	}
	iceMgr := ourice.NewManager(d.keyPair.PublicKeyBase64(), stunServers, cli, d.markPeerICEReady, log.Printf)
	cli.SetSignalHandler(iceMgr.HandleSignal)

	regCtx, regCancel := context.WithTimeout(ctx, 15*time.Second)
	hostname, _ := os.Hostname()
	reg, err := cli.Register(regCtx, control.RegisterRequest{
		PublicKey:   d.keyPair.PublicKeyBase64(),
		Name:        hostname,
		Platform:    runtime.GOOS,
		DERPNodeKey: derpKey.Public().String(),
		WGEndpoint:  d.wgEndpointHint,
	})
	regCancel()
	if err != nil {
		_ = iceMgr.Close()
		_ = derpMgr.Close()
		return fmt.Errorf("register peer: %w", err)
	}
	log.Printf("registered peer id=%s ip4=%s ip6=%s", reg.Peer.ID, reg.Peer.IP4, reg.Peer.IP6)

	prefixes, err := parseAssignedPrefixes(reg.Peer.IP4, reg.Peer.IP6)
	if err != nil {
		_ = iceMgr.Close()
		_ = derpMgr.Close()
		return fmt.Errorf("parse assigned IPs: %w", err)
	}

	d.derpMgr = derpMgr
	d.iceMgr = iceMgr
	tunIf, err := d.tunFactory()("utun", prefixes)
	if err != nil {
		d.derpMgr = nil
		d.iceMgr = nil
		_ = iceMgr.Close()
		_ = derpMgr.Close()
		return fmt.Errorf("create tun: %w", err)
	}
	if err := tunIf.Up(); err != nil {
		_ = tunIf.Close()
		d.derpMgr = nil
		d.iceMgr = nil
		_ = iceMgr.Close()
		_ = derpMgr.Close()
		return fmt.Errorf("tun up: %w", err)
	}
	log.Printf("TUN %s up; addrs=%v", tunIf.Name(), prefixes)

	table := routing.NewTable()
	table.SetListenPort(d.wgListenPort)

	cfgCtx, cfgCancel := context.WithTimeout(ctx, 10*time.Second)
	cfg, err := cli.FetchConfig(cfgCtx, d.activeRoom)
	cfgCancel()
	if err != nil {
		_ = tunIf.Close()
		d.iceMgr = nil
		_ = iceMgr.Close()
		d.derpMgr = nil
		_ = derpMgr.Close()
		return fmt.Errorf("fetch initial config: %w", err)
	}
	if err := applyConfig(tunIf, table, d.keyPair.Private, cfg); err != nil {
		_ = tunIf.Close()
		d.derpMgr = nil
		d.iceMgr = nil
		_ = iceMgr.Close()
		_ = derpMgr.Close()
		return fmt.Errorf("apply initial wg config: %w", err)
	}

	connCtx, connCxl := context.WithCancel(context.Background())
	d.tunIf = tunIf
	d.table = table
	d.cli = cli
	d.derpMgr = derpMgr
	d.iceMgr = iceMgr
	d.connCtx = connCtx
	d.connCxl = connCxl
	d.assignedIP4 = reg.Peer.IP4
	d.assignedIP6 = reg.Peer.IP6
	d.vpnActive.Store(true)

	if d.activeRoom != "" {
		d.startSignalLocked(d.activeRoom)
		d.startICEForRoutes(connCtx, table.All())
	}
	go d.meshLoop(connCtx)

	return nil
}

func (d *daemon) disconnect() {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	if !d.vpnActive.Load() {
		return
	}
	if d.connCxl != nil {
		d.connCxl()
	}
	if d.sigCxl != nil {
		d.sigCxl()
	}
	if d.tunIf != nil {
		_ = d.tunIf.Close()
	}
	if d.iceMgr != nil {
		_ = d.iceMgr.Close()
	}
	if d.derpMgr != nil {
		_ = d.derpMgr.Close()
	}
	d.tunIf = nil
	d.table = nil
	d.cli = nil
	d.derpMgr = nil
	d.iceMgr = nil
	d.assignedIP4 = ""
	d.assignedIP6 = ""
	d.activeRoom = ""
	d.sigCxl = nil
	d.vpnActive.Store(false)
}

func (d *daemon) enterRoom(ctx context.Context, roomID string) error {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	if !d.vpnActive.Load() || d.cli == nil || d.tunIf == nil || d.table == nil {
		return errors.New("VPN is not active")
	}
	cfgCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cfg, err := d.cli.FetchConfig(cfgCtx, roomID)
	if err != nil {
		return fmt.Errorf("fetch room config: %w", err)
	}
	if err := applyConfig(d.tunIf, d.table, d.keyPair.Private, cfg); err != nil {
		return fmt.Errorf("apply room config: %w", err)
	}
	d.activeRoom = roomID
	d.startSignalLocked(roomID)
	d.startICEForRoutes(d.connCtx, d.table.All())
	return nil
}

func (d *daemon) leaveRoom(ctx context.Context) error {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	if !d.vpnActive.Load() || d.cli == nil || d.tunIf == nil || d.table == nil {
		return errors.New("VPN is not active")
	}
	cfgCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cfg, err := d.cli.FetchConfig(cfgCtx, "")
	if err != nil {
		return fmt.Errorf("fetch user config: %w", err)
	}
	if err := applyConfig(d.tunIf, d.table, d.keyPair.Private, cfg); err != nil {
		return fmt.Errorf("apply user config: %w", err)
	}
	d.activeRoom = ""
	if d.sigCxl != nil {
		d.sigCxl()
		d.sigCxl = nil
	}
	return nil
}

func (d *daemon) startSignalLocked(roomID string) {
	if d.cli == nil || d.connCtx == nil || roomID == "" {
		return
	}
	if d.sigCxl != nil {
		d.sigCxl()
		d.sigCxl = nil
	}
	sigCtx, cancel := context.WithCancel(d.connCtx)
	d.sigCxl = cancel
	go d.cli.Run(sigCtx, roomID)
}

func (d *daemon) startICEForRoutes(ctx context.Context, routes []*routing.PeerRoute) {
	if d.iceMgr == nil || ctx == nil {
		return
	}
	for _, r := range routes {
		if r == nil || r.NextHop != nil || r.ICEReady || r.ICEPending {
			continue
		}
		d.iceMgr.StartPeer(ctx, r.PublicKey.String())
	}
}

func (d *daemon) markPeerICEReady(peerKey string) {
	raw, err := base64.StdEncoding.DecodeString(peerKey)
	if err != nil || len(raw) != wgtypes.KeyLen {
		log.Printf("ice ready invalid peer key %q", peerKey)
		return
	}
	var pk wgtypes.Key
	copy(pk[:], raw)
	d.connMu.Lock()
	defer d.connMu.Unlock()
	if d.table == nil || d.tunIf == nil {
		return
	}
	if !d.table.SetICEPending(pk, true, "") {
		return
	}
	started := time.Now()
	if err := d.tunIf.ConfigureIPC(d.table.BuildIPCConfig(d.keyPair.Private)); err != nil {
		log.Printf("ice apply waiting endpoint for %s: %v", peerKey[:min(len(peerKey), 12)], err)
		return
	}
	log.Printf("peer waiting for ICE data-plane validation: %s", peerKey[:min(len(peerKey), 12)])
	go d.validatePeerICE(d.connCtx, peerKey, pk, started)
}

type wgPeerStats struct {
	Found         bool
	LastHandshake time.Time
	RXBytes       uint64
	TXBytes       uint64
}

const (
	iceValidationInterval = 1 * time.Second
	iceValidationTimeout  = 12 * time.Second
)

func (d *daemon) validatePeerICE(ctx context.Context, peerKey string, pk wgtypes.Key, started time.Time) {
	if ctx == nil {
		ctx = context.Background()
	}
	var baseline wgPeerStats
	d.connMu.Lock()
	if d.tunIf != nil {
		if stats, err := readPeerStats(d.tunIf, pk); err == nil {
			baseline = stats
		} else {
			log.Printf("ice validation stats baseline %s: %v", peerKey[:min(len(peerKey), 12)], err)
		}
	}
	d.connMu.Unlock()

	deadline := time.NewTimer(iceValidationTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(iceValidationInterval)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-deadline.C:
			d.failPeerICEValidation(peerKey, pk, "ice-validation-failed")
			return
		case <-tick.C:
			d.connMu.Lock()
			if d.table == nil || d.tunIf == nil {
				d.connMu.Unlock()
				return
			}
			stats, err := readPeerStats(d.tunIf, pk)
			if err != nil {
				d.connMu.Unlock()
				log.Printf("ice validation stats %s: %v", peerKey[:min(len(peerKey), 12)], err)
				continue
			}
			if peerICEValidated(stats, baseline, started) {
				if d.table.SetICEReady(pk, true) {
					if err := d.tunIf.ConfigureIPC(d.table.BuildIPCConfig(d.keyPair.Private)); err != nil {
						log.Printf("ice apply direct endpoint for %s: %v", peerKey[:min(len(peerKey), 12)], err)
						d.connMu.Unlock()
						return
					}
				}
				d.connMu.Unlock()
				log.Printf("peer upgraded to ICE direct: %s", peerKey[:min(len(peerKey), 12)])
				return
			}
			d.connMu.Unlock()
		}
	}
}

func (d *daemon) failPeerICEValidation(peerKey string, pk wgtypes.Key, reason string) {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	if d.table == nil || d.tunIf == nil {
		return
	}
	if !d.table.SetDERPFallback(pk, reason) {
		return
	}
	if err := d.tunIf.ConfigureIPC(d.table.BuildIPCConfig(d.keyPair.Private)); err != nil {
		log.Printf("ice fallback apply for %s: %v", peerKey[:min(len(peerKey), 12)], err)
		return
	}
	log.Printf("peer ICE validation failed; fallback state applied: %s reason=%s", peerKey[:min(len(peerKey), 12)], reason)
}

func peerICEValidated(stats, baseline wgPeerStats, started time.Time) bool {
	if !stats.Found {
		return false
	}
	if stats.LastHandshake.IsZero() || stats.LastHandshake.Before(started.Add(-time.Second)) {
		return false
	}
	if baseline.Found {
		return stats.RXBytes > baseline.RXBytes
	}
	return stats.RXBytes > 0
}

func readPeerStats(iface tunIface, pk wgtypes.Key) (wgPeerStats, error) {
	raw, err := iface.GetIPC()
	if err != nil {
		return wgPeerStats{}, err
	}
	return parsePeerStats(raw, pk), nil
}

func parsePeerStats(raw string, pk wgtypes.Key) wgPeerStats {
	want := hex.EncodeToString(pk[:])
	var cur string
	var stats wgPeerStats
	var sec, nsec int64
	flushHandshake := func() {
		if stats.Found && sec > 0 {
			stats.LastHandshake = time.Unix(sec, nsec)
		}
	}
	for _, line := range strings.Split(raw, "\n") {
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if k == "public_key" {
			flushHandshake()
			cur = v
			stats = wgPeerStats{Found: v == want}
			sec, nsec = 0, 0
			continue
		}
		if cur != want {
			continue
		}
		switch k {
		case "last_handshake_time_sec":
			sec, _ = strconv.ParseInt(v, 10, 64)
		case "last_handshake_time_nsec":
			nsec, _ = strconv.ParseInt(v, 10, 64)
		case "rx_bytes":
			stats.RXBytes, _ = strconv.ParseUint(v, 10, 64)
		case "tx_bytes":
			stats.TXBytes, _ = strconv.ParseUint(v, 10, 64)
		}
	}
	flushHandshake()
	return stats
}

func (d *daemon) meshLoop(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.connMu.Lock()
			cli, tunIf, table, roomID := d.cli, d.tunIf, d.table, d.activeRoom
			if cli == nil || tunIf == nil || table == nil {
				d.connMu.Unlock()
				continue
			}
			fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			cfg, err := cli.FetchConfig(fetchCtx, roomID)
			cancel()
			if err != nil {
				log.Printf("mesh poll: %v", err)
				d.connMu.Unlock()
				continue
			}
			if err := applyConfig(tunIf, table, d.keyPair.Private, cfg); err != nil {
				log.Printf("mesh apply: %v", err)
			}
			if roomID != "" {
				d.startICEForRoutes(ctx, table.All())
			}
			d.connMu.Unlock()
		}
	}
}

// applyConfig (re)builds the routing table from a freshly fetched PeerConfig
// and pushes the WireGuard UAPI snapshot into the kernel device. The control
// plane is the source of truth; we replace, not merge, so removed peers fall
// out naturally.
func applyConfig(iface tunIface, table *routing.Table, priv wgtypes.Key, cfg *control.PeerConfig) error {
	var v4Addrs []netip.Addr
	defaultDERPURL := firstRelayURL(cfg.Relays)
	routes := make([]*routing.PeerRoute, 0, len(cfg.Peers))
	for _, p := range cfg.Peers {
		pub, err := base64.StdEncoding.DecodeString(p.PublicKey)
		if err != nil || len(pub) != wgtypes.KeyLen {
			log.Printf("skip peer %s: invalid public key", p.ID)
			continue
		}
		var pk wgtypes.Key
		copy(pk[:], pub)
		ip4, _ := netip.ParseAddr(p.IP4)
		ip6, _ := netip.ParseAddr(p.IP6)
		route := &routing.PeerRoute{
			PublicKey:   pk,
			ID:          p.ID,
			Name:        p.Name,
			VPN4:        ip4,
			VPN6:        ip6,
			DERPURL:     p.DERPURL,
			DERPNodeKey: p.DERPNodeKey,
			LastSeen:    p.LastSeen,
		}
		if route.DERPURL == "" && p.DERPNodeKey != "" {
			route.DERPURL = defaultDERPURL
		}
		if p.NextHopPublicKey != "" {
			raw, err := base64.StdEncoding.DecodeString(p.NextHopPublicKey)
			if err != nil || len(raw) != wgtypes.KeyLen {
				log.Printf("peer %s: invalid next_hop_public_key", p.ID)
			} else {
				var nh wgtypes.Key
				copy(nh[:], raw)
				route.NextHop = &nh
			}
		}
		if p.Endpoint != "" {
			if ap, err := netip.ParseAddrPort(p.Endpoint); err == nil {
				// Direct endpoint hints are candidates only. DERP remains the
				// baseline path until ICE validates the WG data plane.
				route.DirectAddr = &ap
			} else {
				log.Printf("peer %s: invalid endpoint %q: %v", p.ID, p.Endpoint, err)
			}
		}
		routes = append(routes, route)
		if ip4.IsValid() && ip4.Is4() {
			v4Addrs = append(v4Addrs, ip4)
		}
	}
	table.Replace(routes)
	if err := iface.ConfigureIPC(table.BuildIPCConfig(priv)); err != nil {
		return err
	}
	if err := iface.SyncPeerV4Routes(v4Addrs); err != nil {
		log.Printf("sync peer v4 routes: %v (non-fatal; v6 path may still work)", err)
	}
	log.Printf("applied wg config: %d peers, %d v4 routes", len(cfg.Peers), len(v4Addrs))
	return nil
}

func firstRelayURL(relays []control.RelayEntry) string {
	if len(relays) == 0 {
		return ""
	}
	r := relays[0]
	if r.Hostname == "" {
		return ""
	}
	scheme := "https"
	if r.Port != 443 {
		scheme = "http"
	}
	host := r.Hostname
	if r.Port > 0 {
		host = net.JoinHostPort(r.Hostname, fmt.Sprint(r.Port))
	}
	return scheme + "://" + host + "/derp"
}

func parseAssignedPrefixes(ip4, ip6 string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	if ip4 != "" {
		a, err := netip.ParseAddr(ip4)
		if err != nil {
			return nil, fmt.Errorf("ip4 %q: %w", ip4, err)
		}
		out = append(out, netip.PrefixFrom(a, 32))
	}
	if ip6 != "" {
		a, err := netip.ParseAddr(ip6)
		if err != nil {
			return nil, fmt.Errorf("ip6 %q: %w", ip6, err)
		}
		out = append(out, netip.PrefixFrom(a, 128))
	}
	if len(out) == 0 {
		return nil, errors.New("control plane returned no VPN addresses")
	}
	return out, nil
}

// detectVPNSubnetConflicts returns a list of existing OS routes that overlap
// with our VPN pool 198.18.0.0/15. Best-effort: warns the user but doesn't
// abort, since we install per-peer /32 routes (which take precedence over a
// generic /15 entry already in the table). Returns empty slice on Windows /
// unknown OS.
func detectVPNSubnetConflicts() []string {
	switch runtime.GOOS {
	case "linux":
		out, err := exec.Command("ip", "-4", "route", "show").Output()
		if err != nil {
			return nil
		}
		return scanForOverlap(string(out), "198.18.")
	case "darwin":
		out, err := exec.Command("netstat", "-rn", "-f", "inet").Output()
		if err != nil {
			return nil
		}
		return scanForOverlap(string(out), "198.18")
	}
	return nil
}

func scanForOverlap(text, needle string) []string {
	var hits []string
	for _, line := range strings.Split(text, "\n") {
		l := strings.TrimSpace(line)
		if l == "" || strings.HasPrefix(l, "Destination") || strings.HasPrefix(l, "Routing") {
			continue
		}
		if strings.Contains(l, needle) {
			hits = append(hits, l)
		}
	}
	return hits
}

// loadAuthToken reads the daemon's auth token. Order:
//  1. OURCORD_DAEMON_JWT env var
//  2. <state-dir>/token file (mode 0600 expected)
//
// The CLI handles login (OAuth/OTP) and writes the file; daemon never sees
// browser flows directly.
func loadAuthToken(stateDir string) (string, error) {
	if v := os.Getenv("OURCORD_DAEMON_JWT"); v != "" {
		return v, nil
	}
	path := filepath.Join(stateDir, "token")
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w (run `ourcord-cli login` first or set OURCORD_DAEMON_JWT)", path, err)
	}
	tok := string(data)
	for len(tok) > 0 && (tok[len(tok)-1] == '\n' || tok[len(tok)-1] == '\r' || tok[len(tok)-1] == ' ') {
		tok = tok[:len(tok)-1]
	}
	if tok == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return tok, nil
}
