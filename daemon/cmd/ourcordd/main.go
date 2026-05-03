package main

import (
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"

	"github.com/ourcord/ourcord/daemon/pkg/control"
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

	// Build daemon
	d := &daemon{
		controlURL:     *controlURL,
		keyPair:        kp,
		socketPath:     *socketPath,
		stateDir:       *stateDir,
		wgListenPort:   uint16(*wgListenPort),
		wgEndpointHint: *wgEndpointHint,
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

	vpnActive atomic.Bool

	connMu  sync.Mutex
	connCtx context.Context
	connCxl context.CancelFunc
	tunIf   tunIface
	table   *routing.Table
	cli     controlClient

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
	Name() string
	SyncPeerV4Routes([]netip.Addr) error
}

// controlClient is the subset of *control.Client that connect()/meshLoop
// touches. Tests stub this to point at an httptest.Server-backed shim.
type controlClient interface {
	Register(ctx context.Context, req control.RegisterRequest) (*control.RegisterResponse, error)
	FetchConfig(ctx context.Context, roomID string) (*control.PeerConfig, error)
	Run(ctx context.Context, roomID string)
}

func (d *daemon) tunFactory() func(string, []netip.Prefix) (tunIface, error) {
	if d.newTun != nil {
		return d.newTun
	}
	return func(name string, addrs []netip.Prefix) (tunIface, error) {
		return tun.New(name, addrs)
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
	var hasDirect, hasDERP, hasNextHop, hasConfigured, hasUnresolved bool
	var relayURL string
	for _, r := range routes {
		path := routePath(r)
		switch path {
		case "direct":
			hasDirect = true
		case "derp":
			hasDERP = true
			if relayURL == "" {
				relayURL = r.DERPURL
			}
		case "next-hop":
			hasNextHop = true
		case "configured":
			hasConfigured = true
		default:
			hasUnresolved = true
		}
	}
	if hasUnresolved {
		return hasDERP, relayURL, "degraded"
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
	if hasConfigured {
		return false, "", "configured"
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
			LastError:    r.LastError,
		}
		if r.DirectAddr != nil {
			peer.Endpoint = r.DirectAddr.String()
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
	if r.LastError != "" {
		return "unresolved"
	}
	if r.NextHop != nil {
		return "next-hop"
	}
	if r.DirectAddr != nil {
		return "direct"
	}
	if r.DERPURL != "" {
		return "derp"
	}
	if r.VPN4.IsValid() || r.VPN6.IsValid() {
		return "configured"
	}
	return "unresolved"
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
// Phase-1 limitation: per-peer ICE agents are NOT yet spawned. That means
// only LAN / public-IPv6 P2P will work without explicit candidate exchange.
// Per-peer ICE wiring is the remaining Phase-1 closure work; the
// SignalHandler hook is in place so it can be added without touching the
// basic connect pipeline.
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

	regCtx, regCancel := context.WithTimeout(ctx, 15*time.Second)
	hostname, _ := os.Hostname()
	reg, err := cli.Register(regCtx, control.RegisterRequest{
		PublicKey:  d.keyPair.PublicKeyBase64(),
		Name:       hostname,
		Platform:   runtime.GOOS,
		WGEndpoint: d.wgEndpointHint,
	})
	regCancel()
	if err != nil {
		return fmt.Errorf("register peer: %w", err)
	}
	log.Printf("registered peer id=%s ip4=%s ip6=%s", reg.Peer.ID, reg.Peer.IP4, reg.Peer.IP6)

	prefixes, err := parseAssignedPrefixes(reg.Peer.IP4, reg.Peer.IP6)
	if err != nil {
		return fmt.Errorf("parse assigned IPs: %w", err)
	}

	tunIf, err := d.tunFactory()("utun", prefixes)
	if err != nil {
		return fmt.Errorf("create tun: %w", err)
	}
	if err := tunIf.Up(); err != nil {
		_ = tunIf.Close()
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
		return fmt.Errorf("fetch initial config: %w", err)
	}
	if err := applyConfig(tunIf, table, d.keyPair.Private, cfg); err != nil {
		_ = tunIf.Close()
		return fmt.Errorf("apply initial wg config: %w", err)
	}

	connCtx, connCxl := context.WithCancel(context.Background())
	d.tunIf = tunIf
	d.table = table
	d.cli = cli
	d.connCtx = connCtx
	d.connCxl = connCxl
	d.assignedIP4 = reg.Peer.IP4
	d.assignedIP6 = reg.Peer.IP6
	d.vpnActive.Store(true)

	go cli.Run(connCtx, d.activeRoom)
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
	if d.tunIf != nil {
		_ = d.tunIf.Close()
	}
	d.tunIf = nil
	d.table = nil
	d.cli = nil
	d.assignedIP4 = ""
	d.assignedIP6 = ""
	d.activeRoom = ""
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
	return nil
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
			PublicKey: pk,
			ID:        p.ID,
			Name:      p.Name,
			VPN4:      ip4,
			VPN6:      ip6,
			DERPURL:   p.DERPURL,
			LastSeen:  p.LastSeen,
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
