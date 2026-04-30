package controlclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newTestIdentity() Identity {
	return Identity{
		Region:       "cn-east",
		Hostname:     "relay.example.com",
		Port:         443,
		Mode:         "lobby",
		CapacityKbps: 100_000,
	}
}

// TestSendHeartbeat_RegistersOnFirstCall verifies a fresh client (no relay ID)
// POSTs to /api/relay/register, parses the {"id":"..."} response, and stores
// it for subsequent calls.
func TestSendHeartbeat_RegistersOnFirstCall(t *testing.T) {
	var gotPath, gotMethod, gotAuth, gotCT string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"relay-abc-123"}`))
	}))
	defer srv.Close()

	var registeredWith string
	c := New(srv.URL, "secret-token", "", newTestIdentity())
	c.OnRegister(func(id string) { registeredWith = id })
	c.IncConn()
	c.IncConn()
	c.SetBytesPerSec(4242)

	if err := c.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("sendHeartbeat: %v", err)
	}

	if gotMethod != "POST" {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/relay/register" {
		t.Errorf("path = %q, want /api/relay/register", gotPath)
	}
	if gotAuth != "Bearer secret-token" {
		t.Errorf("auth header = %q, want Bearer secret-token", gotAuth)
	}
	if gotCT != "application/json" {
		t.Errorf("content-type = %q", gotCT)
	}

	var sent heartbeatPayload
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("unmarshal sent body: %v", err)
	}
	if sent.ID != "" {
		t.Errorf("sent.ID = %q on first registration, want empty", sent.ID)
	}
	if sent.Region != "cn-east" || sent.Hostname != "relay.example.com" || sent.Port != 443 || sent.Mode != "lobby" || sent.CapacityKbps != 100_000 {
		t.Errorf("identity not propagated: %+v", sent)
	}
	if sent.ActiveConns != 2 {
		t.Errorf("active_conns = %d, want 2", sent.ActiveConns)
	}
	if sent.BytesPerSec != 4242 {
		t.Errorf("bytes_per_sec = %d, want 4242", sent.BytesPerSec)
	}

	if got := c.RelayID(); got != "relay-abc-123" {
		t.Errorf("RelayID() = %q, want relay-abc-123", got)
	}
	if registeredWith != "relay-abc-123" {
		t.Errorf("OnRegister callback id = %q, want relay-abc-123", registeredWith)
	}
}

// TestSendHeartbeat_SendsExistingID verifies an already-registered client
// sends its known relay ID in the body so the server treats it as an update.
func TestSendHeartbeat_SendsExistingID(t *testing.T) {
	var sent heartbeatPayload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", "relay-existing", newTestIdentity())
	if err := c.sendHeartbeat(context.Background()); err != nil {
		t.Fatalf("sendHeartbeat: %v", err)
	}
	if sent.ID != "relay-existing" {
		t.Errorf("sent.ID = %q, want relay-existing", sent.ID)
	}
	// Should still report the same ID (server returned no body).
	if c.RelayID() != "relay-existing" {
		t.Errorf("RelayID() = %q, want relay-existing", c.RelayID())
	}
}

// TestSendHeartbeat_404TriggersReset verifies that a 404 on heartbeat with a
// known ID clears the in-memory ID and fires the OnReset callback so the
// next tick re-registers from scratch.
func TestSendHeartbeat_404TriggersReset(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	var resetCalls atomic.Int32
	c := New(srv.URL, "tok", "relay-stale", newTestIdentity())
	c.OnReset(func() { resetCalls.Add(1) })

	err := c.sendHeartbeat(context.Background())
	if err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("expected 404 error, got %v", err)
	}
	if c.RelayID() != "" {
		t.Errorf("RelayID after 404 = %q, want empty", c.RelayID())
	}
	if resetCalls.Load() != 1 {
		t.Errorf("OnReset called %d times, want 1", resetCalls.Load())
	}
}

// TestSendHeartbeat_5xxReturnsError verifies that a 5xx response surfaces a
// typed error (no panic, no ID mutation) so the caller can log & retry on
// the next tick.
func TestSendHeartbeat_5xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", "relay-x", newTestIdentity())
	err := c.sendHeartbeat(context.Background())
	if err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("expected 500 error, got %v", err)
	}
	if c.RelayID() != "relay-x" {
		t.Errorf("RelayID mutated on 5xx: %q", c.RelayID())
	}
}

// TestSendHeartbeat_RejectsIncompleteIdentity ensures we fail fast (and never
// hit the network) when required identity fields are missing.
func TestSendHeartbeat_RejectsIncompleteIdentity(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", "", Identity{Hostname: "h"}) // missing region & mode
	err := c.sendHeartbeat(context.Background())
	if err == nil {
		t.Fatal("expected error for incomplete identity")
	}
	if called {
		t.Error("HTTP server should not have been called")
	}
}

// TestSendHeartbeat_NetworkError returns an error (not panic) when the
// control plane is unreachable.
func TestSendHeartbeat_NetworkError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	addr := srv.URL
	srv.Close() // close immediately so connections fail

	c := New(addr, "tok", "relay-x", newTestIdentity())
	c.httpClient.Timeout = 500 * time.Millisecond
	err := c.sendHeartbeat(context.Background())
	if err == nil {
		t.Fatal("expected network error, got nil")
	}
}

// TestSyncBannedKeys_HappyPath verifies the GET path, ban list parsing,
// and that BanList exposes both wireguard- and DERP-shaped keys.
func TestSyncBannedKeys_HappyPath(t *testing.T) {
	var gotPath, gotQuery, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"keys":["wgKey1","wgKey2"],"derp_keys":["nodekey:abc"]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "secret", "relay-77", newTestIdentity())
	if err := c.syncBannedKeys(context.Background()); err != nil {
		t.Fatalf("syncBannedKeys: %v", err)
	}

	if gotPath != "/api/relay/banned-keys" {
		t.Errorf("path = %q", gotPath)
	}
	if gotQuery != "relay_id=relay-77" {
		t.Errorf("query = %q, want relay_id=relay-77", gotQuery)
	}
	if gotAuth != "Bearer secret" {
		t.Errorf("auth = %q", gotAuth)
	}

	bl := c.BanList()
	if !bl.IsBanned("wgKey1") || !bl.IsBanned("wgKey2") {
		t.Error("expected wireguard keys to be banned")
	}
	if bl.IsBanned("not-banned") {
		t.Error("unrelated key reported banned")
	}
	if !bl.IsBannedDERP("nodekey:abc") {
		t.Error("expected DERP key to be banned")
	}
	if bl.IsBannedDERP("nodekey:other") {
		t.Error("unrelated DERP key reported banned")
	}
}

// TestSyncBannedKeys_EmptyResponse verifies an empty list clears any previously
// seen entries (Replace semantics).
func TestSyncBannedKeys_EmptyResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"keys":[],"derp_keys":[]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", "", newTestIdentity())
	c.BanList().Replace([]string{"old"}, []string{"nodekey:old"})
	if err := c.syncBannedKeys(context.Background()); err != nil {
		t.Fatalf("syncBannedKeys: %v", err)
	}
	if c.BanList().IsBanned("old") || c.BanList().IsBannedDERP("nodekey:old") {
		t.Error("stale entries not cleared after empty sync")
	}
}

// TestSyncBannedKeys_OmitsRelayIDQueryWhenUnknown ensures the query string is
// omitted entirely (not set to relay_id=) before first registration.
func TestSyncBannedKeys_OmitsRelayIDQueryWhenUnknown(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		_, _ = w.Write([]byte(`{"keys":[],"derp_keys":[]}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", "", newTestIdentity())
	if err := c.syncBannedKeys(context.Background()); err != nil {
		t.Fatalf("syncBannedKeys: %v", err)
	}
	if gotQuery != "" {
		t.Errorf("query = %q, want empty", gotQuery)
	}
}

// TestSyncBannedKeys_AuthFailure verifies a 401 surfaces an error and does not
// mutate the existing ban list.
func TestSyncBannedKeys_AuthFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(srv.URL, "wrong", "", newTestIdentity())
	c.BanList().Replace([]string{"keep"}, nil)
	err := c.syncBannedKeys(context.Background())
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("expected 401 error, got %v", err)
	}
	if !c.BanList().IsBanned("keep") {
		t.Error("ban list should not be cleared on auth failure")
	}
}

// TestSyncBannedKeys_5xxReturnsError verifies a 5xx is reported as a typed
// error without mutating the existing ban list.
func TestSyncBannedKeys_5xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", "", newTestIdentity())
	c.BanList().Replace([]string{"keep"}, nil)
	err := c.syncBannedKeys(context.Background())
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("expected 502 error, got %v", err)
	}
	if !c.BanList().IsBanned("keep") {
		t.Error("ban list mutated on 5xx")
	}
}

// TestSyncBannedKeys_NetworkError confirms a dead server yields a non-nil
// error rather than a panic.
func TestSyncBannedKeys_NetworkError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	addr := srv.URL
	srv.Close()

	c := New(addr, "tok", "", newTestIdentity())
	c.httpClient.Timeout = 500 * time.Millisecond
	if err := c.syncBannedKeys(context.Background()); err == nil {
		t.Fatal("expected network error, got nil")
	}
}
