package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
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
	"github.com/ourcord/ourcord/daemon/pkg/logging"
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
		logFormat      = flag.String("log-format", "json", "Runtime log format: json or text")
		logFile        = flag.String("log-file", "", "Optional append-only runtime log file")
		wgListenPort   = flag.Int("wg-listen-port", 0, "Pin WireGuard UDP listen port (0 = ephemeral; set for smoke/manual mesh)")
		wgEndpointHint = flag.String("wg-endpoint", "", "Public host:port hint for our wg endpoint sent to control on register (empty = none)")
		disableICE     = flag.Bool("disable-ice", false, "Disable SignalDO/ICE direct path attempts; DERP remains available (diagnostic / constrained-network smoke)")
	)
	flag.Parse()

	if err := configureRuntimeLogging("daemon", *logLevel, *logFormat, *logFile); err != nil {
		fmt.Fprintf(os.Stderr, "configure logging: %v\n", err)
		os.Exit(2)
	}

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
		disableICE:     *disableICE,
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

func configureRuntimeLogging(component, rawLevel, format, filePath string) error {
	level, err := logging.ParseLevel(rawLevel)
	if err != nil {
		return err
	}
	var output io.Writer = os.Stderr
	if filePath != "" {
		if err := os.MkdirAll(filepath.Dir(filePath), 0o700); err != nil {
			return fmt.Errorf("create log directory: %w", err)
		}
		file, err := os.OpenFile(filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o640)
		if err != nil {
			return fmt.Errorf("open log file: %w", err)
		}
		if err := file.Chmod(0o640); err != nil {
			file.Close()
			return fmt.Errorf("chmod log file: %w", err)
		}
		output = io.MultiWriter(os.Stderr, file)
	}
	writer, err := logging.NewWriter(output, component, format, level)
	if err != nil {
		return err
	}
	log.SetFlags(0)
	log.SetPrefix("")
	log.SetOutput(writer)
	return nil
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
	disableICE     bool

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

	// iceRetry tracks per-peer exponential backoff for re-attempting an ICE
	// direct upgrade after the peer degraded to the DERP baseline. Guarded by
	// connMu. Reset to the base interval when a new peer joins the network.
	iceRetry map[wgtypes.Key]*iceRetryState

	// reach tracks per-peer DERP-baseline reachability. The daemon reports
	// wg_reachable=false when a peer is dead on every transport (no ICE and no
	// live DERP data plane) so control can pick an A-B-C next hop without manual
	// /api/peers/connectivity shaping. Guarded by connMu.
	reach map[wgtypes.Key]*peerReachState

	// Connectivity reports are generated by several asynchronous loops. Epoch
	// and seq give control a stable ordering key that survives HTTP/goroutine
	// reordering within one daemon connection lifecycle. Guarded by connMu.
	connectivityEpoch string
	connectivitySeq   map[string]uint64

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
	ReportConnectivity(ctx context.Context, report control.ConnectivityReport) error
	ExchangeDeviceToken(ctx context.Context, deviceToken string) (*control.DeviceTokenResponse, error)
	SetAuthToken(token string)
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
		transport := d.transportStatsLocked()
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
				NetworkID:   roomID,
				RoomID:      roomID,
				PeerCount:   len(routes),
				RelayUsed:   relayUsed,
				RelayURL:    relayURL,
				PathSummary: pathSummary,
				Transport:   transport,
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
	case ipc.CmdEnterRoom, ipc.CmdEnterNetwork:
		networkID := strings.TrimSpace(req.Params["network_id"])
		if networkID == "" {
			networkID = strings.TrimSpace(req.Params["room_id"])
		}
		if networkID == "" {
			return ipc.IPCResponse{OK: false, Error: "network_id required"}
		}
		if err := d.enterRoom(ctx, networkID); err != nil {
			return ipc.IPCResponse{OK: false, Error: err.Error()}
		}
		return ipc.IPCResponse{OK: true}
	case ipc.CmdLeaveRoom, ipc.CmdLeaveNetwork:
		if err := d.leaveRoom(ctx); err != nil {
			return ipc.IPCResponse{OK: false, Error: err.Error()}
		}
		return ipc.IPCResponse{OK: true}
	case ipc.CmdForceDERP:
		peerKey := strings.TrimSpace(req.Params["public_key"])
		reason := strings.TrimSpace(req.Params["reason"])
		if reason == "" {
			reason = "diagnostic-force-derp"
		}
		if peerKey == "" {
			return ipc.IPCResponse{OK: false, Error: "public_key required"}
		}
		if err := d.forceDERP(peerKey, reason); err != nil {
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
	var hasWaiting, hasDirect, hasDERP, hasNextHop, hasDegraded, hasUnresolved bool
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
		case "degraded":
			hasDegraded = true
			if relayURL == "" {
				relayURL = r.DERPURL
			}
		default:
			hasUnresolved = true
		}
	}
	if hasUnresolved {
		return hasDERP, relayURL, "degraded"
	}
	if hasDegraded {
		return relayURL != "", relayURL, "degraded"
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
		if r.DirectAddr != nil {
			peer.CandidateEndpoint = r.DirectAddr.String()
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
	if r.LastError != "" && r.DERPURL != "" && r.DERPNodeKey != "" {
		return "degraded"
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

func (d *daemon) transportStatsLocked() ipc.TransportStats {
	out := ipc.TransportStats{MTU: tun.DefaultMTU}
	if d.iceMgr != nil {
		st := d.iceMgr.Stats()
		out.ICESentPackets = st.SentPackets
		out.ICERecvPackets = st.RecvPackets
		out.ICERecvDrops = st.RecvQueueDrops
		out.ICESendErrors = st.SendErrors
		out.ICERecvErrors = st.RecvErrors
		out.ICEProbeSent = st.ProbeSent
		out.ICEProbeAckSent = st.ProbeAckSent
		out.ICEProbeAckReceived = st.ProbeAckReceived
		out.ICEProbeTimeouts = st.ProbeTimeouts
		out.ICEProbeInvalid = st.ProbeInvalid
		out.ICEMaxPacketBytes = st.MaxPacketBytes
	}
	if d.derpMgr != nil {
		st := d.derpMgr.Stats()
		out.DERPSentPackets = st.SentPackets
		out.DERPRecvPackets = st.RecvPackets
		out.DERPRecvDrops = st.RecvQueueDrops
		out.DERPSuppressedPackets = st.SuppressedPackets
		out.DERPSendErrors = st.SendErrors
		out.DERPRecvErrors = st.RecvErrors
		out.DERPMaxPacketBytes = st.MaxPacketBytes
	}
	return out
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
// signaling channel. ICE must pass an out-of-band probe before WireGuard is
// pointed at ice://; if post-switch WG validation fails, DERP is re-enabled.
func (d *daemon) connect(ctx context.Context) error {
	d.connMu.Lock()
	defer d.connMu.Unlock()
	if d.vpnActive.Load() {
		return errors.New("VPN already active")
	}

	// Credential order: a long-lived device credential (exchanged for
	// short-lived JWTs that the daemon refreshes on its own) beats a raw JWT
	// (legacy: expires after 1h with no self-service renewal).
	deviceToken := loadDeviceToken(d.stateDir)
	var token string
	if deviceToken == "" {
		legacy, err := loadAuthToken(d.stateDir)
		if err != nil {
			return fmt.Errorf("load auth token: %w", err)
		}
		token = legacy
	}

	cli := d.clientFactory()(d.controlURL, token, d.keyPair.PublicKeyBase64())
	var tokenExpiresAt int64
	if deviceToken != "" {
		exCtx, exCancel := context.WithTimeout(ctx, 10*time.Second)
		exch, err := cli.ExchangeDeviceToken(exCtx, deviceToken)
		exCancel()
		if err != nil {
			return fmt.Errorf("exchange device token: %w", err)
		}
		cli.SetAuthToken(exch.Token)
		tokenExpiresAt = exch.ExpiresAt
		log.Printf("device credential exchanged for user JWT (user=%s, expires=%s)", exch.UserID, time.Unix(exch.ExpiresAt, 0).Format(time.RFC3339))
	}
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
	iceMgr := ourice.NewManager(d.keyPair.PublicKeyBase64(), stunServers, cli, d.markPeerICEReady, d.handleICEDegrade, log.Printf)
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
	// Tell ICE the real TUN name (kernel may have renamed e.g. utun → utun7)
	// so candidate gathering excludes our own overlay by ground truth, not
	// just the name-prefix heuristic. Sessions only start once signaling runs,
	// which is after connect() completes.
	iceMgr.SetExcludedInterfaces([]string{tunIf.Name()})

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
	d.syncDERPSuppressionLocked(table.All())

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
	d.connectivityEpoch = newConnectivityEpoch()
	d.connectivitySeq = make(map[string]uint64)
	d.vpnActive.Store(true)

	if d.activeRoom != "" {
		d.reportDERPReachabilityLocked(table.All(), "derp-baseline")
		d.startSignalLocked(d.activeRoom)
		d.startICEForRoutes(connCtx, table.All())
	}
	go d.meshLoop(connCtx)
	go d.iceRetryLoop(connCtx)
	go d.reachabilityLoop(connCtx)
	if deviceToken != "" {
		go d.tokenRefreshLoop(connCtx, cli, deviceToken, tokenExpiresAt)
	}

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
	d.connectivityEpoch = ""
	d.connectivitySeq = nil
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
	d.syncDERPSuppressionLocked(d.table.All())
	d.activeRoom = roomID
	d.resetConnectivitySeqLocked()
	d.reportDERPReachabilityLocked(d.table.All(), "derp-baseline")
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
	d.syncDERPSuppressionLocked(d.table.All())
	d.activeRoom = ""
	d.resetConnectivitySeqLocked()
	if d.sigCxl != nil {
		d.sigCxl()
		d.sigCxl = nil
	}
	return nil
}

func (d *daemon) startSignalLocked(roomID string) {
	if d.disableICE || d.cli == nil || d.connCtx == nil || roomID == "" {
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
	if d.disableICE || d.iceMgr == nil || ctx == nil {
		return
	}
	for _, r := range routes {
		if r == nil || r.ICEReady || r.ICEPending || r.LastError != "" {
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
	if d.table == nil || d.tunIf == nil {
		d.connMu.Unlock()
		return
	}
	// onReady only fires after the ICE manager's sustained-reliability probe, so
	// the direct path is already confirmed: switch WireGuard to it now and clear
	// any prior degrade/backoff for this peer. SetICEReady clears LastError and
	// ICEPending, so a peer that previously degraded re-upgrades cleanly.
	if !d.table.SetICEReady(pk, true) {
		d.connMu.Unlock()
		return
	}
	delete(d.iceRetry, pk)
	d.setDERPSuppressedLocked(pk, true)
	if err := d.tunIf.ConfigureIPC(d.table.BuildIPCConfig(d.keyPair.Private)); err != nil {
		log.Printf("ice apply direct endpoint for %s: %v", peerKey[:min(len(peerKey), 12)], err)
		d.connMu.Unlock()
		return
	}
	// Release connMu before reporting: reportConnectivityAsync re-acquires it.
	d.connMu.Unlock()
	log.Printf("peer upgraded to ICE direct: %s", peerKey[:min(len(peerKey), 12)])
	d.reportConnectivityAsync(peerKey, true, true, "", connectivitySourceICE)
}

// handleICEDegrade is the ICE manager's onDegrade callback: the direct path lost
// liveness, so revert the peer to DERP and schedule a backoff retry.
func (d *daemon) handleICEDegrade(peerKey string, reason string) {
	raw, err := base64.StdEncoding.DecodeString(peerKey)
	if err != nil || len(raw) != wgtypes.KeyLen {
		log.Printf("ice degrade invalid peer key %q", peerKey)
		return
	}
	var pk wgtypes.Key
	copy(pk[:], raw)
	d.failPeerICEValidation(peerKey, pk, reason)
}

// iceRetryState is the per-peer exponential backoff for re-attempting ICE
// direct after a degrade. interval doubles each failed attempt up to a cap and
// resets to the base when a new peer joins the network.
type iceRetryState struct {
	interval    time.Duration
	nextAttempt time.Time
}

const (
	iceRetryBase = 10 * time.Second
	iceRetryCap  = 10 * time.Minute
	iceRetryTick = 5 * time.Second
)

func (st *iceRetryState) backoffAfterAttempt(now time.Time) {
	if st.interval <= 0 {
		st.interval = iceRetryBase
	}
	st.interval *= 2
	if st.interval > iceRetryCap {
		st.interval = iceRetryCap
	}
	st.nextAttempt = now.Add(st.interval)
}

// scheduleICERetryLocked arms (or backs off) the retry timer for a peer that
// just degraded. First failure waits iceRetryBase; each subsequent failure
// doubles the wait up to iceRetryCap. Caller holds connMu.
func (d *daemon) scheduleICERetryLocked(pk wgtypes.Key) {
	if d.iceRetry == nil {
		d.iceRetry = make(map[wgtypes.Key]*iceRetryState)
	}
	st := d.iceRetry[pk]
	if st == nil {
		st = &iceRetryState{interval: iceRetryBase}
		d.iceRetry[pk] = st
		st.nextAttempt = time.Now().Add(st.interval)
		return
	}
	// Same doubling+cap curve as every other retry site — one implementation.
	st.backoffAfterAttempt(time.Now())
}

// resetICEBackoffLocked pulls every degraded peer's retry back to the base
// interval and makes it due immediately. Called when a new peer joins, since a
// topology change can open a direct path that was previously unreachable.
// Caller holds connMu.
func (d *daemon) resetICEBackoffLocked() {
	now := time.Now()
	for _, st := range d.iceRetry {
		st.interval = iceRetryBase
		st.nextAttempt = now
	}
}

// iceRetryLoop periodically re-attempts ICE direct for degraded peers whose
// backoff has elapsed. Runs for the lifetime of a connection.
func (d *daemon) iceRetryLoop(ctx context.Context) {
	t := time.NewTicker(iceRetryTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.retryDegradedICE(ctx)
		}
	}
}

// retryDegradedICE re-initiates ICE for degraded peers past their backoff
// deadline. WireGuard stays on DERP and LastError stays set until the ICE
// manager's sustained probe confirms and markPeerICEReady clears it; the next
// attempt is pushed out by the current interval so an in-flight probe isn't
// restarted, and failPeerICEValidation doubles the interval on failure.
func (d *daemon) retryDegradedICE(ctx context.Context) {
	if d.disableICE || d.iceMgr == nil {
		return
	}
	d.connMu.Lock()
	if d.table == nil {
		d.connMu.Unlock()
		return
	}
	retry := d.collectICERetryLocked(time.Now())
	d.connMu.Unlock()
	for _, pkStr := range retry {
		log.Printf("ice retry attempt for degraded peer %s", pkStr[:min(len(pkStr), 12)])
		d.iceMgr.ClosePeer(pkStr)
		d.iceMgr.StartPeer(ctx, pkStr)
	}
}

func (d *daemon) collectICERetryLocked(now time.Time) []string {
	if d.table == nil {
		return nil
	}
	if d.iceRetry == nil {
		d.iceRetry = make(map[wgtypes.Key]*iceRetryState)
	}
	var retry []string
	for _, r := range d.table.All() {
		if r == nil {
			continue
		}
		needsProbe := r.LastError != "" || r.NextHop != nil
		if !needsProbe {
			continue
		}
		st := d.iceRetry[r.PublicKey]
		if st == nil && r.NextHop != nil {
			st = &iceRetryState{interval: iceRetryBase, nextAttempt: now}
			d.iceRetry[r.PublicKey] = st
		}
		if st == nil || now.Before(st.nextAttempt) {
			continue
		}
		st.backoffAfterAttempt(now)
		retry = append(retry, r.PublicKey.String())
	}
	return retry
}

func (d *daemon) failPeerICEValidation(peerKey string, pk wgtypes.Key, reason string) {
	d.connMu.Lock()
	if d.table == nil || d.tunIf == nil {
		d.connMu.Unlock()
		return
	}
	if !d.table.SetDERPFallback(pk, reason) {
		d.connMu.Unlock()
		return
	}
	wgReachable := false
	for _, r := range d.table.All() {
		if r != nil && r.PublicKey == pk && r.DERPURL != "" && r.DERPNodeKey != "" {
			wgReachable = true
			break
		}
	}
	d.setDERPSuppressedLocked(pk, false)
	if err := d.tunIf.ConfigureIPC(d.table.BuildIPCConfig(d.keyPair.Private)); err != nil {
		log.Printf("ice fallback apply for %s: %v", peerKey[:min(len(peerKey), 12)], err)
		d.connMu.Unlock()
		return
	}
	if d.iceMgr != nil {
		d.iceMgr.ClosePeer(peerKey)
	}
	d.scheduleICERetryLocked(pk)
	d.connMu.Unlock()
	log.Printf("peer ICE validation failed; fallback state applied: %s reason=%s", peerKey[:min(len(peerKey), 12)], reason)
	reportReason := reason
	if wgReachable {
		reportReason = "derp-fallback"
		if reason != "" {
			reportReason += ":" + reason
		}
	}
	d.reportConnectivityAsync(peerKey, false, wgReachable, reportReason, connectivitySourceReachability)
}

func (d *daemon) forceDERP(peerKey string, reason string) error {
	raw, err := base64.StdEncoding.DecodeString(peerKey)
	if err != nil || len(raw) != wgtypes.KeyLen {
		return fmt.Errorf("invalid public_key")
	}
	var pk wgtypes.Key
	copy(pk[:], raw)
	d.connMu.Lock()
	if !d.vpnActive.Load() || d.table == nil || d.tunIf == nil {
		d.connMu.Unlock()
		return errors.New("VPN is not active")
	}
	table := d.table
	d.connMu.Unlock()
	found := false
	for _, r := range table.All() {
		if r != nil && r.PublicKey == pk {
			found = true
			break
		}
	}
	if !found {
		return errors.New("peer not found")
	}
	d.failPeerICEValidation(peerKey, pk, reason)
	return nil
}

const (
	connectivitySourceDERPBaseline = "derp_baseline"
	connectivitySourceICE          = "ice"
	connectivitySourceReachability = "reachability"
)

func (d *daemon) reportConnectivityAsync(peerKey string, iceDirect bool, wgReachable bool, reason string, source string) {
	d.connMu.Lock()
	cli, ctx, report, ok := d.nextConnectivityReportLocked(peerKey, iceDirect, wgReachable, reason, source)
	d.connMu.Unlock()
	if ok {
		d.reportConnectivityWith(cli, ctx, report)
	}
}

func (d *daemon) reportDERPReachabilityLocked(routes []*routing.PeerRoute, reason string) {
	if d.cli == nil || d.activeRoom == "" || d.connCtx == nil {
		return
	}
	for _, r := range routes {
		if r == nil || r.NextHop != nil || r.ICEReady || r.DERPURL == "" || r.DERPNodeKey == "" {
			continue
		}
		// Don't optimistically re-assert reachability for a peer the reachability
		// monitor has already found dead on every transport, or this periodic
		// baseline report would clobber its wg_reachable=false back to true.
		if st := d.reach[r.PublicKey]; st != nil && st.reportedUnreachable {
			continue
		}
		cli, ctx, report, ok := d.nextConnectivityReportLocked(r.PublicKey.String(), false, true, reason, connectivitySourceDERPBaseline)
		if ok {
			d.reportConnectivityWith(cli, ctx, report)
		}
	}
}

func (d *daemon) reportICEDirectReachabilityLocked(routes []*routing.PeerRoute) {
	if d.cli == nil || d.activeRoom == "" || d.connCtx == nil {
		return
	}
	for _, r := range routes {
		if r == nil || r.NextHop != nil || !r.ICEReady {
			continue
		}
		cli, ctx, report, ok := d.nextConnectivityReportLocked(r.PublicKey.String(), true, true, "", connectivitySourceICE)
		if ok {
			d.reportConnectivityWith(cli, ctx, report)
		}
	}
}

func (d *daemon) nextConnectivityReportLocked(peerKey string, iceDirect bool, wgReachable bool, reason string, source string) (controlClient, context.Context, control.ConnectivityReport, bool) {
	cli, networkID, ctx := d.cli, d.activeRoom, d.connCtx
	if cli == nil || networkID == "" || ctx == nil {
		return nil, nil, control.ConnectivityReport{}, false
	}
	if d.connectivityEpoch == "" {
		d.connectivityEpoch = newConnectivityEpoch()
	}
	if d.connectivitySeq == nil {
		d.connectivitySeq = make(map[string]uint64)
	}
	k := networkID + "\n" + peerKey
	d.connectivitySeq[k]++
	transport := ""
	if iceDirect {
		transport = "ice"
	} else if wgReachable && strings.HasPrefix(reason, "derp") {
		transport = "derp"
	}
	return cli, ctx, control.ConnectivityReport{
		NetworkID:     networkID,
		PeerPublicKey: peerKey,
		Direct:        iceDirect,
		ICEDirect:     iceDirect,
		WGReachable:   wgReachable,
		Transport:     transport,
		Reason:        reason,
		Source:        source,
		ReporterEpoch: d.connectivityEpoch,
		Seq:           d.connectivitySeq[k],
		ObservedAt:    time.Now().Unix(),
	}, true
}

func (d *daemon) reportConnectivityWith(cli controlClient, ctx context.Context, report control.ConnectivityReport) {
	if cli == nil || ctx == nil {
		return
	}
	go func() {
		reportCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		if err := cli.ReportConnectivity(reportCtx, report); err != nil {
			peerKey := report.PeerPublicKey
			log.Printf("report connectivity %s seq=%d ice_direct=%v wg_reachable=%v: %v", peerKey[:min(len(peerKey), 12)], report.Seq, report.ICEDirect, report.WGReachable, err)
		}
	}()
}

// resetConnectivitySeqLocked starts a fresh reporting session (new epoch,
// counters back to 1). The epoch MUST rotate together with the counters:
// re-entering a network with the old epoch would replay low seq values that
// control's same-epoch rule (excluded.seq > stored seq) silently rejects until
// the counter climbs past the previous high-water mark. A new epoch instead
// routes the first reports through the cross-epoch arbitration, which is built
// for exactly this restart semantic.
func (d *daemon) resetConnectivitySeqLocked() {
	d.connectivityEpoch = newConnectivityEpoch()
	d.connectivitySeq = make(map[string]uint64)
}

func newConnectivityEpoch() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func (d *daemon) setDERPSuppressedLocked(pk wgtypes.Key, suppressed bool) {
	if d.derpMgr == nil || d.table == nil {
		return
	}
	for _, r := range d.table.All() {
		if r == nil || r.PublicKey != pk || r.DERPNodeKey == "" {
			continue
		}
		d.derpMgr.SetSuppressed(r.DERPNodeKey, suppressed)
		return
	}
}

func (d *daemon) syncDERPSuppressionLocked(routes []*routing.PeerRoute) {
	if d.derpMgr == nil {
		return
	}
	for _, r := range routes {
		if r == nil || r.DERPNodeKey == "" {
			continue
		}
		d.derpMgr.SetSuppressed(r.DERPNodeKey, r.ICEPending || r.ICEReady)
	}
}

// peerReachState tracks DERP-baseline liveness for one peer between monitor
// ticks. lastProgress is the last time we saw a fresh WG handshake or growing
// rx_bytes (persistent-keepalive=25s keeps a healthy DERP path producing rx).
type peerReachState struct {
	firstSeen           time.Time
	lastRx              uint64
	haveLastRx          bool
	lastProgress        time.Time
	reportedUnreachable bool
}

type peerLiveness struct {
	lastHandshakeSec int64
	rxBytes          uint64
}

const (
	reachMonitorTick = 10 * time.Second
	reachGraceSec    = 30 // wait this long after first seeing a peer before judging (initial handshake)
	reachStaleSec    = 70 // no handshake/rx progress for this long ⇒ dead (≈3 missed 25s keepalives)
)

// reachableFromSample reports whether a single liveness sample shows the DERP
// baseline path is alive: a fresh handshake, or rx_bytes that grew since the
// previous sample. Pure for unit testing.
func reachableFromSample(prevRx uint64, havePrev bool, l peerLiveness, nowUnix, staleSec int64) bool {
	if l.lastHandshakeSec > 0 && nowUnix-l.lastHandshakeSec <= staleSec {
		return true
	}
	return havePrev && l.rxBytes > prevRx
}

// flagUnreachable reports whether a baseline peer that has shown no progress
// should now be declared unreachable: past the initial grace and with no
// progress for longer than the stale window. Pure for unit testing.
func flagUnreachable(firstSeen, lastProgress, now time.Time, graceSec, staleSec int64) bool {
	return now.Sub(firstSeen) > time.Duration(graceSec)*time.Second &&
		now.Sub(lastProgress) > time.Duration(staleSec)*time.Second
}

// readPeerLiveness parses the WireGuard UAPI snapshot into per-peer handshake
// age and rx byte counters, keyed by lowercase-hex public key (UAPI format).
func readPeerLiveness(iface tunIface) (map[string]peerLiveness, error) {
	raw, err := iface.GetIPC()
	if err != nil {
		return nil, err
	}
	out := make(map[string]peerLiveness)
	var cur string
	for _, line := range strings.Split(raw, "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "public_key":
			cur = v
			out[cur] = peerLiveness{}
		case "last_handshake_time_sec":
			if cur != "" {
				e := out[cur]
				e.lastHandshakeSec, _ = strconv.ParseInt(v, 10, 64)
				out[cur] = e
			}
		case "rx_bytes":
			if cur != "" {
				e := out[cur]
				e.rxBytes, _ = strconv.ParseUint(v, 10, 64)
				out[cur] = e
			}
		}
	}
	return out, nil
}

// reachabilityLoop periodically re-evaluates DERP-baseline peer reachability so
// the daemon can report wg_reachable transitions to control. Runs for the
// lifetime of a connection.
func (d *daemon) reachabilityLoop(ctx context.Context) {
	t := time.NewTicker(reachMonitorTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.checkReachability(ctx)
		}
	}
}

// checkReachability samples WG liveness for every DERP-baseline candidate peer
// (direct, not ICE, with a DERP endpoint) and reports wg_reachable=false when a
// peer goes dark / true again on recovery. ICE peers report via the ICE path.
// Next-hop (indirect) peers are skipped here because they are not currently
// direct WG edges; direct recovery for them is handled by background ICE probes,
// and markPeerICEReady clears NextHop once the probe validates the path.
func (d *daemon) checkReachability(ctx context.Context) {
	d.connMu.Lock()
	if d.table == nil || d.tunIf == nil {
		d.connMu.Unlock()
		return
	}
	tunIf := d.tunIf
	routes := d.table.All()
	d.connMu.Unlock()

	// GetIPC dumps and parses the whole WireGuard device state — O(peers)
	// string work. Do it lock-free (it touches no daemon state) so the 10s
	// tick never stalls connect/teardown or the report paths behind connMu.
	live, err := readPeerLiveness(tunIf)
	if err != nil {
		log.Printf("reachability stats: %v", err)
		return
	}

	d.connMu.Lock()
	if d.table == nil {
		// Disconnected while we were parsing; drop the stale sample.
		d.connMu.Unlock()
		return
	}
	if d.reach == nil {
		d.reach = make(map[wgtypes.Key]*peerReachState)
	}
	now := time.Now()
	nowUnix := now.Unix()
	type change struct {
		key       string
		reachable bool
	}
	type pendingReport struct {
		cli    controlClient
		ctx    context.Context
		report control.ConnectivityReport
	}
	var changes []change
	var pending []pendingReport
	seen := make(map[wgtypes.Key]bool)
	for _, r := range routes {
		if r == nil || r.NextHop != nil || r.ICEReady || r.ICEPending || r.DERPURL == "" || r.DERPNodeKey == "" {
			continue
		}
		seen[r.PublicKey] = true
		st := d.reach[r.PublicKey]
		if st == nil {
			st = &peerReachState{firstSeen: now, lastProgress: now}
			d.reach[r.PublicKey] = st
		}
		l := live[fmt.Sprintf("%x", r.PublicKey[:])]
		if reachableFromSample(st.lastRx, st.haveLastRx, l, nowUnix, reachStaleSec) {
			st.lastProgress = now
			if st.reportedUnreachable {
				st.reportedUnreachable = false
				changes = append(changes, change{r.PublicKey.String(), true})
			}
		} else if !st.reportedUnreachable && flagUnreachable(st.firstSeen, st.lastProgress, now, reachGraceSec, reachStaleSec) {
			st.reportedUnreachable = true
			changes = append(changes, change{r.PublicKey.String(), false})
		}
		st.lastRx = l.rxBytes
		st.haveLastRx = true
	}
	for k := range d.reach {
		if !seen[k] {
			delete(d.reach, k)
		}
	}
	for _, c := range changes {
		reason := "unreachable"
		if c.reachable {
			reason = "derp-recovery"
		}
		cli, ctx, report, ok := d.nextConnectivityReportLocked(c.key, false, c.reachable, reason, connectivitySourceReachability)
		if ok {
			pending = append(pending, pendingReport{cli: cli, ctx: ctx, report: report})
		}
	}
	d.connMu.Unlock()

	for _, p := range pending {
		short := p.report.PeerPublicKey[:min(len(p.report.PeerPublicKey), 12)]
		if p.report.WGReachable {
			log.Printf("peer reachable again via DERP baseline: %s", short)
		} else {
			log.Printf("peer unreachable on all transports; reporting wg_reachable=false: %s", short)
		}
		d.reportConnectivityWith(p.cli, p.ctx, p.report)
	}
}

func peerKeySet(routes []*routing.PeerRoute) map[wgtypes.Key]struct{} {
	set := make(map[wgtypes.Key]struct{}, len(routes))
	for _, r := range routes {
		if r != nil {
			set[r.PublicKey] = struct{}{}
		}
	}
	return set
}

func hasNewPeer(before map[wgtypes.Key]struct{}, after []*routing.PeerRoute) bool {
	for _, r := range after {
		if r == nil {
			continue
		}
		if _, ok := before[r.PublicKey]; !ok {
			return true
		}
	}
	return false
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
			before := peerKeySet(table.All())
			if err := applyConfig(tunIf, table, d.keyPair.Private, cfg); err != nil {
				log.Printf("mesh apply: %v", err)
			}
			// A new peer joining can open a direct path that was previously
			// unreachable, so pull every degraded peer's ICE retry back to the
			// base interval and let it re-attempt immediately.
			if hasNewPeer(before, table.All()) {
				d.resetICEBackoffLocked()
			}
			d.syncDERPSuppressionLocked(table.All())
			if roomID != "" {
				d.reportDERPReachabilityLocked(table.All(), "derp-baseline")
				d.reportICEDirectReachabilityLocked(table.All())
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

// loadDeviceToken reads the device credential (dt_…), if enrolled. Order:
//  1. OURCORD_DEVICE_TOKEN env var
//  2. <state-dir>/device.token file (mode 0600 expected)
//
// Returns "" when no device credential is configured; connect() then falls
// back to the legacy raw-JWT path.
func loadDeviceToken(stateDir string) string {
	if v := os.Getenv("OURCORD_DEVICE_TOKEN"); v != "" {
		return strings.TrimSpace(v)
	}
	data, err := os.ReadFile(filepath.Join(stateDir, "device.token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

const (
	// Refresh the JWT well before expiry so control restarts / transient
	// failures have headroom; never spin faster than the floor.
	tokenRefreshLead  = 10 * time.Minute
	tokenRefreshFloor = 30 * time.Second
	tokenRefreshRetry = 30 * time.Second
)

// tokenRefreshDelay computes how long to wait before exchanging again. Pure
// for unit testing.
func tokenRefreshDelay(expiresAt, nowUnix int64) time.Duration {
	d := time.Duration(expiresAt-nowUnix)*time.Second - tokenRefreshLead
	if d < tokenRefreshFloor {
		return tokenRefreshFloor
	}
	return d
}

// tokenRefreshLoop keeps the client's JWT fresh by re-exchanging the device
// credential before each expiry. On failure it retries on a short interval —
// the current JWT keeps working until its real expiry, so transient control
// outages shorter than the refresh lead are absorbed silently.
func (d *daemon) tokenRefreshLoop(ctx context.Context, cli controlClient, deviceToken string, expiresAt int64) {
	for {
		delay := tokenRefreshDelay(expiresAt, time.Now().Unix())
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		exCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		exch, err := cli.ExchangeDeviceToken(exCtx, deviceToken)
		cancel()
		if err != nil {
			log.Printf("device token refresh failed (retrying in %s): %v", tokenRefreshRetry, err)
			expiresAt = time.Now().Unix() + int64((tokenRefreshLead+tokenRefreshRetry)/time.Second)
			continue
		}
		cli.SetAuthToken(exch.Token)
		expiresAt = exch.ExpiresAt
		log.Printf("device token refreshed; JWT valid until %s", time.Unix(exch.ExpiresAt, 0).Format(time.RFC3339))
	}
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
