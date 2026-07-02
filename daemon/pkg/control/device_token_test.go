package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestExchangeDeviceToken_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/device" || r.Method != "POST" {
			http.Error(w, "wrong route", http.StatusNotFound)
			return
		}
		// The exchange endpoint is unauthenticated: no bearer should be sent.
		if r.Header.Get("Authorization") != "" {
			http.Error(w, "unexpected bearer", http.StatusBadRequest)
			return
		}
		var body struct {
			DeviceToken string `json:"device_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DeviceToken != "dt_secret" {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(DeviceTokenResponse{Token: "jwt-1", UserID: "u1", ExpiresAt: 12345})
	}))
	defer srv.Close()

	c := New(srv.URL, "", "pk")
	got, err := c.ExchangeDeviceToken(context.Background(), "dt_secret")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if got.Token != "jwt-1" || got.UserID != "u1" || got.ExpiresAt != 12345 {
		t.Fatalf("unexpected response: %+v", got)
	}
}

func TestExchangeDeviceToken_Unauthorized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"Unauthorized"}`, http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(srv.URL, "", "pk")
	if _, err := c.ExchangeDeviceToken(context.Background(), "dt_revoked"); err == nil {
		t.Fatal("expected error for 401 response")
	}
}

func TestSetAuthToken_SwapsBearerForSubsequentRequests(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"servers": []any{}})
	}))
	defer srv.Close()

	c := New(srv.URL, "old-token", "pk")
	if _, err := c.FetchSTUNServers(context.Background()); err != nil {
		t.Fatalf("fetch 1: %v", err)
	}
	c.SetAuthToken("new-token")
	if _, err := c.FetchSTUNServers(context.Background()); err != nil {
		t.Fatalf("fetch 2: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] != "Bearer old-token" || seen[1] != "Bearer new-token" {
		t.Fatalf("bearer rotation not applied, saw %v", seen)
	}
}
