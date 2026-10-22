package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestDeviceRefreshRespectsRetryAfter(t *testing.T) {
	for _, status := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		for _, header := range []string{"60", time.Now().Add(time.Minute).UTC().Format(http.TimeFormat)} {
			t.Run(fmt.Sprintf("%d/%s", status, header), func(t *testing.T) {
				var exchanges atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.URL.Path == "/api/auth/device" {
						exchanges.Add(1)
						w.Header().Set("Retry-After", header)
						w.WriteHeader(status)
						_, _ = io.WriteString(w, `{"error":"rate limit exceeded","retry_after":60}`)
						return
					}
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = io.WriteString(w, `{"error":"expired"}`)
				}))
				defer server.Close()
				b := refreshTestBridge(t, server)
				// These operations finish one after another, so in-flight sharing
				// alone cannot suppress retries during the server's cooldown.
				for _, call := range []struct{ method, params string }{
					{"messages.list", `{"room_id":"room"}`},
					{"lobbies.list", `{}`},
					{"presence.update", `{"voice_room_id":""}`},
					{"messages.list", `{"room_id":"room"}`},
				} {
					if _, err := b.dispatch(call.method, json.RawMessage(call.params)); !isHTTPStatus(err, status) {
						t.Fatalf("poll error = %v, want %d", err, status)
					}
				}
				if got := exchanges.Load(); got != 1 {
					t.Fatalf("requests during Retry-After = %d, want 1", got)
				}
			})
		}
	}
}

func TestDeviceRefreshCooldownExpiresAndRecovers(t *testing.T) {
	for _, dateHeader := range []bool{false, true} {
		for _, missingJWT := range []bool{false, true} {
			t.Run(fmt.Sprintf("date=%t/missingJWT=%t", dateHeader, missingJWT), func(t *testing.T) {
				start := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
				var clock atomic.Int64
				clock.Store(start.UnixNano())
				var exchanges atomic.Int32
				var recovered atomic.Bool
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.URL.Path == "/api/auth/device" {
						exchanges.Add(1)
						if !recovered.Load() {
							header := "60"
							if dateHeader {
								header = start.Add(time.Minute).Format(http.TimeFormat)
							}
							w.Header().Set("Retry-After", header)
							w.WriteHeader(http.StatusTooManyRequests)
							_, _ = io.WriteString(w, `{"error":"rate limit exceeded"}`)
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
				b.clock = func() time.Time { return time.Unix(0, clock.Load()) }
				if missingJWT {
					if err := b.credentialStore().Delete(credentialService, jwtCredential); err != nil {
						t.Fatal(err)
					}
				}
				for seconds := 0; seconds < 60; seconds += 3 {
					clock.Store(start.Add(time.Duration(seconds) * time.Second).UnixNano())
					if _, err := b.dispatch("messages.list", json.RawMessage(`{"room_id":"room"}`)); !isHTTPStatus(err, 429) {
						t.Fatalf("poll at +%ds: %v", seconds, err)
					}
				}
				clock.Store(start.Add(time.Minute - time.Nanosecond).UnixNano())
				if _, err := b.dispatch("lobbies.list", nil); !isHTTPStatus(err, 429) {
					t.Fatalf("early retry: %v", err)
				}
				if got := exchanges.Load(); got != 1 {
					t.Fatalf("cooldown exchanges = %d, want 1", got)
				}
				recovered.Store(true)
				clock.Store(start.Add(time.Minute).UnixNano())
				if _, err := b.dispatch("lobbies.list", nil); err != nil {
					t.Fatal(err)
				}
				if got := exchanges.Load(); got != 2 {
					t.Fatalf("recovery exchanges = %d, want 2", got)
				}
				if token, err := b.token(); err != nil || token != "fresh-jwt" {
					t.Fatalf("recovery token = %q (%v)", token, err)
				}
			})
		}
	}
}

func TestDeviceRefreshCooldownDoesNotBlockChangedCredentials(t *testing.T) {
	for _, changed := range []string{"device credential", "control service", "account JWT"} {
		t.Run(changed, func(t *testing.T) {
			var exchanges, alternateExchanges atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/auth/device" {
					exchanges.Add(1)
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["device_token"] == "dt_replaced-credential" {
						_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
						return
					}
					w.Header().Set("Retry-After", "60")
					w.WriteHeader(http.StatusTooManyRequests)
					_, _ = io.WriteString(w, `{"error":"rate limit exceeded"}`)
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
			if _, err := b.dispatch("lobbies.list", nil); !isHTTPStatus(err, 429) {
				t.Fatalf("initial error: %v", err)
			}
			switch changed {
			case "device credential":
				if err := b.credentialStore().Set(credentialService, deviceCredential, "dt_replaced-credential"); err != nil {
					t.Fatal(err)
				}
			case "control service":
				alternate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path != "/api/auth/device" {
						t.Errorf("unexpected alternate request: %s", r.URL.Path)
					}
					alternateExchanges.Add(1)
					_, _ = io.WriteString(w, `{"token":"fresh-jwt"}`)
				}))
				defer alternate.Close()
				b.controlURL = alternate.URL
			case "account JWT":
				if err := b.credentialStore().Set(credentialService, jwtCredential, "fresh-jwt"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := b.dispatch("lobbies.list", nil); err != nil {
				t.Fatal(err)
			}
			want := int32(1)
			if changed == "device credential" {
				want = 2
			}
			if got := exchanges.Load(); got != want {
				t.Fatalf("original exchanges = %d, want %d", got, want)
			}
			if changed == "control service" && alternateExchanges.Load() != 1 {
				t.Fatal("new control service was not used")
			}
		})
	}
}

func TestInvalidRetryAfterDoesNotPreventImmediateRecovery(t *testing.T) {
	for _, header := range []string{"", "0", "-1", "+60", "1.5", "not-a-date", "18446744073709551616", "Thu, 01 Jan 1970 00:00:00 GMT"} {
		t.Run(header, func(t *testing.T) {
			var exchanges atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/auth/device" {
					if exchanges.Add(1) == 1 {
						w.Header().Set("Retry-After", header)
						w.WriteHeader(http.StatusTooManyRequests)
						_, _ = io.WriteString(w, `{"error":"rate limit exceeded"}`)
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
			if _, err := b.dispatch("lobbies.list", nil); !isHTTPStatus(err, 429) {
				t.Fatalf("initial error: %v", err)
			}
			if _, err := b.dispatch("lobbies.list", nil); err != nil {
				t.Fatal(err)
			}
			if got := exchanges.Load(); got != 2 {
				t.Fatalf("exchanges = %d, want 2", got)
			}
		})
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	for _, header := range []string{"60", " 60 ", "00060", now.Add(time.Minute).Format(http.TimeFormat)} {
		if got := parseRetryAfter(header, now); !got.Equal(now.Add(time.Minute)) {
			t.Errorf("%q: %v", header, got)
		}
	}
	for _, header := range []string{"", "0", "-1", "+60", "1.5", "1e3", "9223372037", "18446744073709551616", now.Format(http.TimeFormat)} {
		if got := parseRetryAfter(header, now); !got.IsZero() {
			t.Errorf("%q unexpectedly delays until %v", header, got)
		}
	}
}
