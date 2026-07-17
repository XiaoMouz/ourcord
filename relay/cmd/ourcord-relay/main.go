// OurCord relay server — extends Tailscale DERP with control plane integration.
// Provides: DERP relay, banned-key enforcement, per-connection rate limiting,
// and heartbeat registration with the OurCord control plane.
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ourcord/ourcord/relay/pkg/controlclient"
	"github.com/ourcord/ourcord/relay/pkg/limiter"
	"github.com/ourcord/ourcord/relay/pkg/logging"
	"github.com/ourcord/ourcord/relay/pkg/state"
	"tailscale.com/derp/derpserver"
	"tailscale.com/net/stunserver"
	"tailscale.com/tailcfg"
	"tailscale.com/types/logger"
)

func main() {
	var (
		addr         = flag.String("addr", ":443", "listen address (host:port)")
		controlURL   = flag.String("control-url", "", "OurCord control plane URL")
		authToken    = flag.String("auth-token", relayAuthTokenFromEnv(), "Bearer token for control plane auth (or OURCORD_RELAY_AUTH_TOKEN)")
		relayID      = flag.String("relay-id", "", "relay server ID (from control plane registration); leave empty on first run")
		region       = flag.String("region", "unknown", "geographic region name")
		hostname     = flag.String("hostname", "", "public hostname clients connect to (required for control registration)")
		publicPort   = flag.Int("public-port", 0, "public TCP port reported to control (0=derive from --addr)")
		mode         = flag.String("mode", "personal", "relay mode: personal | lobby | rental")
		capacityKbps = flag.Int("capacity-kbps", 10000, "soft total capacity hint reported to control plane")
		limitKbps    = flag.Int("limit-kbps", 0, "per-connection bandwidth limit in kbps (0=unlimited; 128 recommended for voice floor)")
		certFile     = flag.String("cert", "", "TLS certificate file (PEM)")
		keyFile      = flag.String("key", "", "TLS key file (PEM)")
		meshPSKFile  = flag.String("mesh-psk-file", "", "mesh pre-shared key file for DERP mesh")
		stun         = flag.Bool("stun", true, "run STUN server on same address (UDP)")
		stunPort     = flag.Int("stun-port", 3478, "STUN listen port")
		stateDir     = flag.String("state-dir", state.DefaultDir, "Persistent state directory (DERP node key, relay id)")
		logLevel     = flag.String("log-level", "info", "Runtime log level: debug, info, warn, error")
		logFormat    = flag.String("log-format", "json", "Runtime log format: json or text")
		logFile      = flag.String("log-file", "", "Optional append-only runtime log file")
	)
	flag.Parse()

	if err := configureRuntimeLogging("relay", *logLevel, *logFormat, *logFile); err != nil {
		fmt.Fprintf(os.Stderr, "configure logging: %v\n", err)
		os.Exit(2)
	}

	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()

	// Load (or create + persist) DERP node key. Stable across restarts so
	// clients keep their pinned-key trust.
	nodeKeyPath := filepath.Join(*stateDir, "node.key")
	serverPrivKey, err := state.LoadOrCreateNodeKey(nodeKeyPath)
	if err != nil {
		log.Fatalf("Load DERP node key (%s): %v", nodeKeyPath, err)
	}
	log.Printf("Server public key: %s (state: %s)", serverPrivKey.Public().ShortString(), nodeKeyPath)
	log.Printf("Region: %s", *region)

	// Persistent relay-id from previous registration. Empty on first run.
	relayIDPath := filepath.Join(*stateDir, "relay.id")
	if *relayID == "" {
		persistedID, err := state.LoadRelayID(relayIDPath)
		if err != nil {
			log.Printf("Warning: read relay-id %s: %v", relayIDPath, err)
		} else if persistedID != "" {
			log.Printf("Resuming as relay %s (from %s)", persistedID, relayIDPath)
			*relayID = persistedID
		}
	}

	// DERP server
	derpSrv := derpserver.New(serverPrivKey, logger.WithPrefix(log.Printf, "[derp] "))
	if meshKey := loadOptionalFile(*meshPSKFile); meshKey != "" {
		if err := derpSrv.SetMeshKey(meshKey); err != nil {
			log.Fatalf("SetMeshKey: %v", err)
		}
	}

	// Rate limiter — bytes per second per connection
	limitBps := *limitKbps * 1024 / 8
	lm := limiter.NewManager(limitBps)
	if lm.Enabled() {
		log.Printf("Per-connection rate limit: %d kbps (%d Bps)", *limitKbps, limitBps)
		// G10: drop idle limiter map entries periodically so they don't leak
		// when a conn is torn down via a path that bypasses limitedConn.Close.
		go lm.Run(rootCtx, 5*time.Minute)
	}

	// Control plane client
	var cc *controlclient.Client
	if *controlURL != "" {
		if *hostname == "" {
			log.Fatalf("--hostname required when --control-url is set")
		}
		// Public port for control registration: --public-port wins (reverse
		// proxy, e.g. Caddy terminating on 443); otherwise derived from
		// --addr. I9: a mis-typed --addr port is fatal, not silently 443.
		port, portErr := relayRegistrationPort(*addr, *publicPort)
		if portErr != nil {
			log.Fatalf("invalid relay public port: %v", portErr)
		}
		cc = controlclient.New(*controlURL, *authToken, *relayID, controlclient.Identity{
			Region:       *region,
			Hostname:     *hostname,
			Port:         port,
			Mode:         *mode,
			CapacityKbps: *capacityKbps,
		})
		// Persist control-issued relay ID so subsequent restarts keep the
		// same relay_servers row instead of leaking duplicates.
		cc.OnRegister(func(id string) {
			if err := state.SaveRelayID(relayIDPath, id); err != nil {
				log.Printf("Warning: persist relay-id %s: %v", relayIDPath, err)
			}
		})
		cc.OnReset(func() {
			if err := state.ClearRelayID(relayIDPath); err != nil {
				log.Printf("Warning: clear relay-id %s: %v", relayIDPath, err)
			}
		})
		go cc.Run(rootCtx, 5*time.Minute, 30*time.Second)
		log.Printf("Control plane: %s (mode=%s)", *controlURL, *mode)
	}

	// Build HTTP mux
	mux := http.NewServeMux()

	// Local admission controller for DERP — runs on a separate plain-HTTP
	// loopback listener (the public listener may be TLS). derpserver POSTs
	// {NodePublic, Source} after the client's key-exchange frame; we reply
	// {Allow: bool}. This is the only layer where banned DERP clients can
	// be reliably rejected — the WebSocket Sec-WebSocket-Protocol header is
	// not set by DERP clients, so an HTTP-layer check is a no-op.
	admitMux := http.NewServeMux()
	admitMux.HandleFunc("/internal/derp-admit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		var req tailcfg.DERPAdmitClientRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		allow := true
		// G12: req.NodePublic is a Tailscale DERP node key (NodePublic.String()
		// → "nodekey:HEX..."), NOT a WireGuard base64 public key. The control
		// plane returns both sets via /api/relay/banned-keys (keys + derp_keys);
		// we use the DERP-side set here so a banned user can't reconnect via
		// pure DERP. The legacy IsBanned(WG-key) check is intentionally omitted
		// here because the comparison would always miss.
		if cc != nil && cc.BanList().IsBannedDERP(req.NodePublic.String()) {
			allow = false
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(tailcfg.DERPAdmitClientResponse{Allow: allow})
	})

	admitLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("admit listen: %v", err)
	}
	// Q2: keep admitSrv at function scope so the SIGTERM handler below can
	// gracefully shut it down. Without this, the goroutine outlives the public
	// server, the loopback listener stays bound, and any restart races against
	// the lingering port + goroutine.
	admitSrv := &http.Server{
		// I6: cap header read + total write so a hung client (even on
		// loopback) can't pin a goroutine forever. Admit requests are tiny
		// JSON in/out, 5s is generous.
		Handler:           admitMux,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      5 * time.Second,
	}
	go func() {
		_ = admitSrv.Serve(admitLn)
	}()
	admitURL := "http://" + admitLn.Addr().String() + "/internal/derp-admit"
	log.Printf("DERP admission controller: %s", admitURL)

	// DERP HTTP handler with connection counting only (ban check is at admit URL).
	derpHandler := derpserver.Handler(derpSrv)
	mux.HandleFunc("/derp", func(w http.ResponseWriter, r *http.Request) {
		if cc != nil {
			cc.IncConn()
			defer cc.DecConn()
		}
		derpHandler.ServeHTTP(w, r)
	})
	mux.HandleFunc("/derp/probe", derpserver.ProbeHandler)
	mux.HandleFunc("/derp/latency-check", derpserver.ProbeHandler)
	mux.HandleFunc("/generate_204", derpserver.ServeNoContent)

	// Health / status endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","region":%q,"ts":%d}`, *region, time.Now().Unix())
	})

	// Wire the admission controller into derpserver. Fail-open so a broken
	// loopback doesn't take down the relay; ban evasion is bounded by the
	// relay-process lifetime.
	if cc != nil {
		derpSrv.SetVerifyClientURL(admitURL)
		derpSrv.SetVerifyClientURLFailOpen(true)
	}

	// Build TLS config if certs provided
	var tlsCfg *tls.Config
	if *certFile != "" && *keyFile != "" {
		cert, err := tls.LoadX509KeyPair(*certFile, *keyFile)
		if err != nil {
			log.Fatalf("TLS cert error: %v", err)
		}
		tlsCfg = &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS12,
		}
		log.Printf("TLS enabled")
	}

	// Build a (possibly rate-limited) listener so all bytes — DERP and HTTP both —
	// observe the per-connection bandwidth floor. Wrapping at the listener level
	// keeps us out of derpserver internals while still enforcing the limit.
	rawLn, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("Listen %s: %v", *addr, err)
	}
	limitedLn := limiter.WrapListener(rootCtx, rawLn, lm)
	if tlsCfg != nil {
		limitedLn = tls.NewListener(limitedLn, tlsCfg)
	}

	// L3: harden the public-facing HTTPS server against slow-loris / half-open
	// TLS handshakes. ReadHeaderTimeout caps how long we wait for the request
	// line + headers; IdleTimeout reaps idle keep-alive connections. We must
	// NOT set ReadTimeout or WriteTimeout because DERP clients hold long-lived
	// streaming connections and those timeouts would forcibly tear them down.
	srv := &http.Server{
		Handler:           mux,
		TLSConfig:         tlsCfg,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// STUN server (UDP)
	if *stun {
		stunSrv := stunserver.New(rootCtx)
		go func() {
			stunAddr := fmt.Sprintf(":%d", *stunPort)
			if err := stunSrv.ListenAndServe(stunAddr); err != nil {
				log.Printf("STUN server error: %v", err)
			}
		}()
		log.Printf("STUN listening on UDP :%d", *stunPort)
	}

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-quit
		log.Println("Shutting down...")
		shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			log.Printf("HTTP shutdown: %v", err)
		}
		// Q2: shut down the loopback admit server too so the goroutine and
		// listener don't outlive the main process during graceful exit.
		if err := admitSrv.Shutdown(shutCtx); err != nil {
			log.Printf("admit shutdown: %v", err)
		}
		_ = admitLn.Close()
		rootCancel()
	}()

	// Periodic sampler: convert byte counter delta → bytes/sec for heartbeat.
	if cc != nil {
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			var lastTotal int64
			lastTime := time.Now()
			for {
				select {
				case <-rootCtx.Done():
					return
				case now := <-ticker.C:
					total := lm.BytesTotal()
					elapsed := now.Sub(lastTime).Seconds()
					if elapsed > 0 {
						bps := int64(float64(total-lastTotal) / elapsed)
						if bps < 0 {
							bps = 0
						}
						cc.SetBytesPerSec(bps)
					}
					lastTotal = total
					lastTime = now
				}
			}
		}()
	}

	log.Printf("Listening on %s", *addr)
	if err := srv.Serve(limitedLn); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

func relayAuthTokenFromEnv() string {
	return strings.TrimSpace(os.Getenv("OURCORD_RELAY_AUTH_TOKEN"))
}

func relayRegistrationPort(listenAddr string, publicPort int) (int, error) {
	if publicPort < 0 || publicPort > 65535 {
		return 0, fmt.Errorf("--public-port must be between 0 and 65535")
	}
	if publicPort != 0 {
		return publicPort, nil
	}
	_, rawPort, err := net.SplitHostPort(listenAddr)
	if err != nil {
		// I9: keep the fallback visible instead of silently registering 443.
		log.Printf("warn: could not split host/port from --addr %q (registering port 443): %v", listenAddr, err)
		return 443, nil
	}
	var port int
	if _, err := fmt.Sscanf(rawPort, "%d", &port); err != nil || port < 0 || port > 65535 {
		return 0, fmt.Errorf("could not derive a valid port from --addr %q", listenAddr)
	}
	return port, nil
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

func loadOptionalFile(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("Warning: could not read %s: %v", path, err)
		return ""
	}
	return strings.TrimSpace(string(data))
}
