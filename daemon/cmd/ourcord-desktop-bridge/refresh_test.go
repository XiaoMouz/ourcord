package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestConcurrentAccountPollsShareOneRefresh(t *testing.T) {
	for _, remainingExchanges := range []int{100, 1} {
		t.Run(fmt.Sprintf("remaining exchanges %d", remainingExchanges), func(t *testing.T) {
			const requests = 3
			var staleReads, exchanges atomic.Int32
			var phase atomic.Int32
			phase.Store(1)
			allStale := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/auth/device" {
					if int(exchanges.Add(1)) > remainingExchanges {
						w.WriteHeader(http.StatusTooManyRequests)
						_, _ = io.WriteString(w, `{"error":"rate limit exceeded"}`)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]string{"token": fmt.Sprintf("fresh-%d", phase.Load())})
					return
				}
				if r.Header.Get("Authorization") == "Bearer expired-jwt" {
					// Force all three real UI operations to observe the expired
					// JWT before any can install the replacement credential.
					if staleReads.Add(1) == requests {
						close(allStale)
					}
					select {
					case <-allStale:
					case <-r.Context().Done():
						return
					}
				}
				if r.Header.Get("Authorization") != fmt.Sprintf("Bearer fresh-%d", phase.Load()) {
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = io.WriteString(w, `{"error":"expired"}`)
					return
				}
				_, _ = io.WriteString(w, `{}`)
			}))
			defer server.Close()
			b := refreshTestBridge(t, server)
			var wg sync.WaitGroup
			failures := make(chan error, requests)
			for _, call := range []struct {
				method string
				params string
			}{
				{"lobbies.list", `{}`},
				{"messages.list", `{"room_id":"room"}`},
				{"presence.update", `{"voice_room_id":""}`},
			} {
				wg.Go(func() {
					_, err := b.dispatch(call.method, json.RawMessage(call.params))
					failures <- err
				})
			}
			wg.Wait()
			close(failures)
			for err := range failures {
				if err != nil {
					t.Errorf("poll failed instead of reusing the refreshed JWT: %v", err)
				}
			}
			if got := exchanges.Load(); got != 1 {
				t.Fatalf("device exchanges = %d, want 1 for one expired JWT", got)
			}
			if remainingExchanges > 1 {
				// A later expiration must still perform a new exchange.
				phase.Store(2)
				if _, err := b.dispatch("lobbies.list", nil); err != nil {
					t.Fatal(err)
				}
				if got := exchanges.Load(); got != 2 {
					t.Fatalf("next expiration did not refresh: %d exchanges", got)
				}
			}
		})
	}
}

func refreshTestBridge(t *testing.T, server *httptest.Server) *bridge {
	t.Helper()
	store := fileCredentialStore{dir: t.TempDir()}
	if err := store.Set(credentialService, jwtCredential, "expired-jwt"); err != nil {
		t.Fatal(err)
	}
	if err := store.Set(credentialService, deviceCredential, "dt_test-device-token"); err != nil {
		t.Fatal(err)
	}
	return &bridge{
		controlURL: server.URL, serviceURL: server.URL,
		http:        &http.Client{Timeout: 5 * time.Second},
		credentials: store, stateDir: t.TempDir(),
		socketPath: filepath.Join(t.TempDir(), "missing.sock"),
	}
}

func TestAccountRefreshCanRetryAfterFailure(t *testing.T) {
	var exchanges atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/auth/device" {
			if exchanges.Add(1) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(w, `{"error":"temporary failure"}`)
				return
			}
			_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fresh-jwt" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"expired"}`)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	b := refreshTestBridge(t, server)
	if _, err := b.dispatch("lobbies.list", nil); !isHTTPStatus(err, http.StatusServiceUnavailable) {
		t.Fatalf("first refresh should fail with 503: %v", err)
	}
	if _, err := b.dispatch("lobbies.list", nil); err != nil {
		t.Fatalf("second refresh could not recover: %v", err)
	}
	if exchanges.Load() != 2 {
		t.Fatalf("device exchanges = %d, want two attempts", exchanges.Load())
	}
}

func TestAuthStatusReusesTokenRefreshedDuringProfileRequest(t *testing.T) {
	profileStarted := make(chan struct{})
	replacementUsed := make(chan struct{})
	var exchanges atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/auth/device":
			exchanges.Add(1)
			_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
			return
		case "/api/me":
			if r.Header.Get("Authorization") == "Bearer expired-jwt" {
				close(profileStarted)
				select {
				case <-replacementUsed:
				case <-r.Context().Done():
					return
				}
			}
		case "/api/lobbies":
			if r.Header.Get("Authorization") == "Bearer fresh-jwt" {
				close(replacementUsed)
			}
		}
		if r.Header.Get("Authorization") != "Bearer fresh-jwt" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"error":"expired"}`)
			return
		}
		_, _ = io.WriteString(w, `{"user":{"id":"user-1"}}`)
	}))
	defer server.Close()
	b := refreshTestBridge(t, server)
	authDone := make(chan error, 1)
	go func() { _, err := b.dispatch("auth.status", nil); authDone <- err }()
	select {
	case <-profileStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("auth.status did not request the profile")
	}
	if _, err := b.dispatch("lobbies.list", nil); err != nil {
		t.Fatal(err)
	}
	if err := <-authDone; err != nil {
		t.Fatal(err)
	}
	if got := exchanges.Load(); got != 1 {
		t.Fatalf("auth.status repeated another operation's refresh: %d exchanges", got)
	}
}
