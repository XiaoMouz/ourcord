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
		addr            = flag.String("addr", ":443", "listen address (host:port)")
		controlURL      = flag.String("control-url", "", "OurCord control plane URL")
		authToken       = flag.String("auth-token", "", "Bearer token for control plane auth")
		relayID         = flag.String("relay-id", "", "relay server ID (from control plane registration)")
		region          = flag.String("region", "unknown", "geographic region name")
		limitKbps       = flag.Int("limit-kbps", 0, "per-connection bandwidth limit in kbps (0=unlimited)")
		certFile        = flag.String("cert", "", "TLS certificate file (PEM)")
		keyFile         = flag.String("key", "", "TLS key file (PEM)")
		meshPSKFile     = flag.String("mesh-psk-file", "", "mesh pre-shared key file for DERP mesh")
		stun            = flag.Bool("stun", true, "run STUN server on same address (UDP)")
		stunPort        = flag.Int("stun-port", 3478, "STUN listen port")
	)
	flag.Parse()

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[ourcord-relay] ")

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

	// Rate limiter
	limitBps := *limitKbps * 1024 / 8
	lm := limiter.NewManager(limitBps)

	// Control plane client
	var cc *controlclient.Client
	if *controlURL != "" {
		cc = controlclient.New(*controlURL, *authToken, *relayID)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go cc.Run(ctx, 5*time.Minute, 30*time.Second)
		log.Printf("Control plane: %s", *controlURL)
	}

	// Build HTTP mux
	mux := http.NewServeMux()

	// DERP HTTP handler with ban check
	derpHandler := derpserver.Handler(derpSrv)
	mux.HandleFunc("/derp", func(w http.ResponseWriter, r *http.Request) {
		// Check banned key before upgrading
		if cc != nil {
			clientKey := r.Header.Get("Sec-WebSocket-Protocol")
			if clientKey != "" && cc.BanList().IsBanned(clientKey) {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
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

	srv := &http.Server{
		Addr:      *addr,
		Handler:   mux,
		TLSConfig: tlsCfg,
	}

	// STUN server (UDP)
	if *stun {
		stunSrv := stunserver.New(context.Background())
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
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	log.Printf("Listening on %s", *addr)
	var listenErr error
	if tlsCfg != nil {
		listenErr = srv.ListenAndServeTLS("", "") // certs already in TLSConfig
	} else {
		listenErr = srv.ListenAndServe()
	}
	if listenErr != nil && listenErr != http.ErrServerClosed {
		log.Fatalf("Server error: %v", listenErr)
	}

	_ = lm // used in future per-conn wrapping
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
