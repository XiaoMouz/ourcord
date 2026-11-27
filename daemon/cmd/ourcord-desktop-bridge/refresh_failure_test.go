package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func TestConcurrentAccountPollsShareFailedRefresh(t *testing.T) {
	for _, failure := range []struct {
		name       string
		status     int
		body       string
		missingJWT bool
	}{
		{"revoked device", 401, `{"error":"revoked"}`, false},
		{"rate limited", 429, `{"error":"rate limited"}`, false},
		{"service unavailable", 503, `{"error":"temporary failure"}`, false},
		{"invalid response", 200, `{"token":""}`, false},
		{"disconnected response", 0, "", false},
		{"missing JWT", 503, `{"error":"temporary failure"}`, true},
	} {
		t.Run(failure.name, func(t *testing.T) {
			const callers = 3
			var exchanges, expiredReads atomic.Int32
			var recovered atomic.Bool
			allExpired := make(chan struct{})
			started := make(chan struct{})
			release := make(chan struct{})
			var releaseOnce sync.Once
			resume := func() { releaseOnce.Do(func() { close(release) }) }
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/auth/device" {
					attempt := exchanges.Add(1)
					if recovered.Load() {
						_, _ = io.WriteString(w, `{"token":"recovered-jwt"}`)
						return
					}
					if attempt == 1 {
						close(started)
						<-release
					}
					if failure.status == 0 {
						connection, _, err := w.(http.Hijacker).Hijack()
						if err != nil {
							t.Error(err)
							return
						}
						_ = connection.Close()
						return
					}
					w.WriteHeader(failure.status)
					_, _ = io.WriteString(w, failure.body)
					return
				}
				if r.Header.Get("Authorization") != "Bearer recovered-jwt" {
					if expiredReads.Add(1) == callers {
						close(allExpired)
					}
					select {
					case <-allExpired:
					case <-r.Context().Done():
						return
					}
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = io.WriteString(w, `{"error":"expired"}`)
					return
				}
				_, _ = io.WriteString(w, `{}`)
			}))
			defer server.Close()
			defer resume()
			b := refreshTestBridge(t, server)
			if failure.missingJWT {
				if err := b.credentialStore().Delete(credentialService, jwtCredential); err != nil {
					t.Fatal(err)
				}
			}

			done := make(chan error, callers)
			for _, call := range []struct{ method, params string }{
				{"lobbies.list", `{}`},
				{"messages.list", `{"room_id":"room"}`},
				{"presence.update", `{"voice_room_id":""}`},
			} {
				go func() { _, err := b.dispatch(call.method, json.RawMessage(call.params)); done <- err }()
			}
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("polls did not reach the device exchange")
			}
			// Keep the first real HTTP exchange pending while the other UI
			// operations process their 401s and join that in-flight refresh.
			select {
			case err := <-done:
				t.Fatalf("poll returned while its refresh was still held: %v", err)
			case <-time.After(200 * time.Millisecond):
			}
			resume()
			for range callers {
				err := <-done
				if err == nil {
					t.Error("failed refresh reported success")
				}
				if failure.status >= 400 && !failure.missingJWT && !isHTTPStatus(err, failure.status) {
					t.Errorf("poll error = %v, want HTTP %d", err, failure.status)
				}
			}
			if got := exchanges.Load(); got != 1 {
				t.Fatalf("one overlapping failure generated %d exchanges, want 1", got)
			}
			if token, err := b.token(); failure.missingJWT {
				if !errors.Is(err, keyring.ErrNotFound) {
					t.Fatalf("failure stored JWT %q: %v", token, err)
				}
			} else if err != nil || token != "expired-jwt" {
				t.Fatalf("failure changed the stored JWT: %q (%v)", token, err)
			}
			// Failures are shared only with current waiters. A later explicit
			// request must be able to recover immediately, without a sticky error.
			recovered.Store(true)
			if _, err := b.dispatch("lobbies.list", nil); err != nil {
				t.Fatal(err)
			}
			if got := exchanges.Load(); got != 2 {
				t.Fatalf("recovery exchanges = %d, want 2", got)
			}
			if token, err := b.token(); err != nil || token != "recovered-jwt" {
				t.Fatalf("recovery JWT = %q (%v)", token, err)
			}
		})
	}
}
