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
	"os/signal"
	"path/filepath"
	"runtime"
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
		controlURL = flag.String("control-url", "https://control.ourcord.app", "Control plane URL")
		socketPath = flag.String("socket", ipc.DefaultSocketPath(), "Unix socket path for IPC")
		stateDir   = flag.String("state-dir", wg.DefaultStateDir(), "Persistent state directory (WireGuard private key, etc.)")
		logLevel   = flag.String("log-level", "info", "Log level: debug, info, error")
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
		controlURL: *controlURL,
		keyPair:    kp,
		socketPath: *socketPath,
		stateDir:   *stateDir,
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
	log.Println("Daemon ready. Waiting for IPC commands.")

	if err := ipcSrv.Serve(ctx); err != nil {
		log.Printf("IPC server error: %v", err)
	}
}

// daemon implements ipc.Handler and coordinates VPN subsystems.
type daemon struct {
	controlURL string
	keyPair    *wg.KeyPair
	socketPath string
	stateDir   string

	vpnActive atomic.Bool

	connMu  sync.Mutex
	connCtx context.Context
	connCxl context.CancelFunc
	tunIf   *tun.Interface
	table   *routing.Table
	cli     *control.Client
}

func (d *daemon) HandleIPC(ctx context.Context, req ipc.IPCRequest) ipc.IPCResponse {
	switch req.Cmd {
	case ipc.CmdStatus:
		return ipc.IPCResponse{
			OK: true,
			Data: ipc.DaemonStatus{
				Running:   true,
				VPNActive: d.vpnActive.Load(),
			},
		}
	case ipc.CmdConnect:
		if err := d.connect(ctx); err != nil {
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

// connect wires the daemon into the OurCord overlay (G1):
//   1. Read the auth token (env OURCORD_DAEMON_JWT or <state-dir>/token).
//   2. POST /api/peers/register → receive allocated VPN IPv4/IPv6.
//   3. tun.New() — kernel TUN + per-platform OS address assignment (W1/G14).
//   4. wireguard-go device.Up() with the registered private key.
//   5. Initial /api/peers/config fetch → routing.Table → device.IpcSet.
//   6. Background goroutines: control WS Run() (signaling for ICE) +
//      30s mesh poller (re-fetch /peers/config and apply diff).
//
// Phase-1 limitation: per-peer ICE agents are NOT yet spawned. That means
// only LAN / public-IPv6 P2P will work without explicit candidate exchange.
// Per-peer ICE wiring is Phase-2 / media-layer work; the SignalHandler hook
// is in place so it can be added without touching the connect pipeline.
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

	cli := control.New(d.controlURL, token, d.keyPair.PublicKeyBase64())

	regCtx, regCancel := context.WithTimeout(ctx, 15*time.Second)
	hostname, _ := os.Hostname()
	reg, err := cli.Register(regCtx, control.RegisterRequest{
		PublicKey: d.keyPair.PublicKeyBase64(),
		Name:      hostname,
		Platform:  runtime.GOOS,
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

	tunIf, err := tun.New("utun", prefixes)
	if err != nil {
		return fmt.Errorf("create tun: %w", err)
	}
	if err := tunIf.Up(); err != nil {
		_ = tunIf.Close()
		return fmt.Errorf("tun up: %w", err)
	}
	log.Printf("TUN %s up; addrs=%v", tunIf.Name(), prefixes)

	table := routing.NewTable()

	cfgCtx, cfgCancel := context.WithTimeout(ctx, 10*time.Second)
	cfg, err := cli.FetchConfig(cfgCtx, "")
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
	d.vpnActive.Store(true)

	go cli.Run(connCtx, "")
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
	d.vpnActive.Store(false)
}

func (d *daemon) meshLoop(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fetchCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			cfg, err := d.cli.FetchConfig(fetchCtx, "")
			cancel()
			if err != nil {
				log.Printf("mesh poll: %v", err)
				continue
			}
			if err := applyConfig(d.tunIf, d.table, d.keyPair.Private, cfg); err != nil {
				log.Printf("mesh apply: %v", err)
			}
		}
	}
}

// applyConfig (re)builds the routing table from a freshly fetched PeerConfig
// and pushes the WireGuard UAPI snapshot into the kernel device. The control
// plane is the source of truth; we replace, not merge, so removed peers fall
// out naturally.
func applyConfig(iface *tun.Interface, table *routing.Table, priv wgtypes.Key, cfg *control.PeerConfig) error {
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
		table.Upsert(&routing.PeerRoute{
			PublicKey: pk,
			VPN4:      ip4,
			VPN6:      ip6,
		})
	}
	return iface.ConfigureIPC(table.BuildIPCConfig(priv))
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

// loadAuthToken reads the daemon's auth token. Order:
//   1. OURCORD_DAEMON_JWT env var
//   2. <state-dir>/token file (mode 0600 expected)
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
