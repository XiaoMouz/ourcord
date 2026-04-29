// OurCord relay server — extends Tailscale DERP with control plane integration.
// Provides: DERP relay, banned-key enforcement, per-connection rate limiting,
// and heartbeat registration with the OurCord control plane.
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ourcord/ourcord/relay/pkg/controlclient"
	"github.com/ourcord/ourcord/relay/pkg/limiter"
	"tailscale.com/derp/derpserver"
	"tailscale.com/net/stunserver"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func main() {
	var (
		addr         = flag.String("addr", ":443", "listen address (host:port)")
		controlURL   = flag.String("control-url", "", "OurCord control plane URL")
		authToken    = flag.String("auth-token", "", "Bearer token for control plane auth")
		relayID      = flag.String("relay-id", "", "relay server ID (from control plane registration); leave empty on first run")
		region       = flag.String("region", "unknown", "geographic region name")
		hostname     = flag.String("hostname", "", "public hostname clients connect to (required for control registration)")
		mode         = flag.String("mode", "personal", "relay mode: personal | lobby | rental")
		capacityKbps = flag.Int("capacity-kbps", 10000, "soft total capacity hint reported to control plane")
		limitKbps    = flag.Int("limit-kbps", 0, "per-connection bandwidth limit in kbps (0=unlimited; 128 recommended for voice floor)")
		certFile     = flag.String("cert", "", "TLS certificate file (PEM)")
		keyFile      = flag.String("key", "", "TLS key file (PEM)")
		meshPSKFile  = flag.String("mesh-psk-file", "", "mesh pre-shared key file for DERP mesh")
		stun         = flag.Bool("stun", true, "run STUN server on same address (UDP)")
		stunPort     = flag.Int("stun-port", 3478, "STUN listen port")
	)
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[ourcord-relay] ")

	rootCtx, rootCancel := context.WithCancel(context.Background())
	defer rootCancel()

	// Generate or load server key
	serverPrivKey := key.NewNode()
	log.Printf("Server public key: %s", serverPrivKey.Public().ShortString())
	log.Printf("Region: %s", *region)

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
	}

	// Control plane client
	var cc *controlclient.Client
	if *controlURL != "" {
		if *hostname == "" {
			log.Fatalf("--hostname required when --control-url is set")
		}
		// Parse port out of addr (best effort) for heartbeat reporting
		port := 443
		if _, p, err := net.SplitHostPort(*addr); err == nil {
			fmt.Sscanf(p, "%d", &port)
		}
		cc = controlclient.New(*controlURL, *authToken, *relayID, controlclient.Identity{
			Region:       *region,
			Hostname:     *hostname,
			Port:         port,
			Mode:         *mode,
			CapacityKbps: *capacityKbps,
		})
		go cc.Run(rootCtx, 5*time.Minute, 30*time.Second)
		log.Printf("Control plane: %s (mode=%s)", *controlURL, *mode)
	}

	// Build HTTP mux
	mux := http.NewServeMux()

	// DERP HTTP handler with ban check + connection counting
	derpHandler := derpserver.Handler(derpSrv)
	mux.HandleFunc("/derp", func(w http.ResponseWriter, r *http.Request) {
		// Check banned key before upgrading
		if cc != nil {
			clientKey := r.Header.Get("Sec-WebSocket-Protocol")
			if clientKey != "" && cc.BanList().IsBanned(clientKey) {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
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

	srv := &http.Server{Handler: mux, TLSConfig: tlsCfg}

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
		srv.Shutdown(shutCtx)
		rootCancel()
	}()

	log.Printf("Listening on %s", *addr)
	if err := srv.Serve(limitedLn); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
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
	return string(data)
}
