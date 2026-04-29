// ourcordd — OurCord VPN daemon
// Manages WireGuard VPN, hole punching, DERP relay client, and IPC for UI.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
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
	}

	// IPC server
	ipcSrv := ipc.NewServer(*socketPath, d)
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
	// vpnActive is read by the IPC dispatch goroutine and written by both
	// connect/disconnect handlers; using atomic.Bool keeps the access
	// race-free without a mutex around the whole struct. Once G-B lands and
	// the connect pipeline runs in its own goroutine this is the contract
	// it observes.
	vpnActive atomic.Bool
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
		d.vpnActive.Store(false)
		return ipc.IPCResponse{OK: true}
	case ipc.CmdPing:
		return ipc.IPCResponse{OK: true, Data: map[string]string{"pong": "ok"}}
	default:
		return ipc.IPCResponse{OK: false, Error: fmt.Sprintf("unknown command: %s", req.Cmd)}
	}
}

func (d *daemon) connect(ctx context.Context) error {
	// J9: connect() is intentionally NOT marked successful until the full
	// pipeline (G1: control register → IPC → ICE/DERP/WG) lands. Returning
	// nil + setting vpnActive=true here would have downstream UI/integration
	// tests reporting "VPN active" while no packets actually flow. Fail loud.
	_ = ctx
	log.Printf("VPN connect requested (control: %s) — G1 pipeline not yet wired", d.controlURL)
	return fmt.Errorf("connect not implemented; awaiting G1 (control register + ICE/DERP/WG wiring)")
}
