package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"tailscale.com/tailcfg"
)

// admitDecision decides whether a DERP client key is allowed to connect.
// isBannedDERP may be nil (no control plane wired) in which case everyone is
// admitted. Otherwise a key is admitted iff it is not on the DERP banlist.
func admitDecision(isBannedDERP func(string) bool, nodeKey string) bool {
	if isBannedDERP == nil {
		return true
	}
	return !isBannedDERP(nodeKey)
}

// derpAdmitHandler builds the /internal/derp-admit handler the DERP server POSTs
// to after a client's key-exchange frame. It replies {Allow: bool}. This is the
// only layer that can reliably reject banned DERP clients (the WebSocket
// Sec-WebSocket-Protocol header is not set by DERP clients, so an HTTP-layer
// check is a no-op). Fail-open at the caller: derpserver.SetVerifyClientURLFailOpen.
func derpAdmitHandler(isBannedDERP func(string) bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		var req tailcfg.DERPAdmitClientRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		allow := admitDecision(isBannedDERP, req.NodePublic.String())
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(tailcfg.DERPAdmitClientResponse{Allow: allow})
	}
}

// healthHandler builds the /health endpoint reporting the relay region.
func healthHandler(region string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":"ok","region":%q,"ts":%d}`, region, time.Now().Unix())
	}
}
