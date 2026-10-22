package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zalando/go-keyring"
)

func TestPendingLoginSurvivesAppReinitialization(t *testing.T) {
	credentials := &lockedCredentials{memoryCredentials: memoryCredentials{}}
	var originalChallenge string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/auth/desktop/exchange" {
			http.NotFound(writer, request)
			return
		}
		var body struct {
			Code     string `json:"code"`
			Verifier string `json:"code_verifier"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if body.Code != strings.Repeat("a", 64) || pkceChallenge(body.Verifier) != originalChallenge {
			writer.WriteHeader(http.StatusUnauthorized)
			_, _ = writer.Write([]byte(`{"error":"invalid or expired authorization code"}`))
			return
		}
		_, _ = writer.Write([]byte(`{"token":"synthetic-test-token","user_id":"test-user"}`))
	}))
	defer server.Close()
	first := &bridge{controlURL: server.URL, http: server.Client(), credentials: credentials}
	started, err := first.dispatch("auth.begin", nil)
	if err != nil {
		t.Fatal(err)
	}
	loginURL, err := url.Parse(started.(map[string]string)["google_url"])
	if err != nil {
		t.Fatal(err)
	}
	originalChallenge = loginURL.Query().Get("code_challenge")
	reopened := &bridge{
		controlURL: server.URL, http: server.Client(), credentials: credentials,
		stateDir: t.TempDir(), socketPath: "missing-test-daemon",
	}
	if _, err := reopened.dispatch("auth.begin", nil); err != nil {
		t.Fatal(err)
	}
	params, err := json.Marshal(map[string]string{"code": strings.Repeat("a", 64)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.dispatch("auth.exchange", params); err != nil {
		t.Fatalf("pending login must survive ordinary app reinitialization: %v", err)
	}
}

func TestPendingLoginConcurrentResume(test *testing.T) {
	desktop := &bridge{controlURL: "https://control.test", credentials: &lockedCredentials{memoryCredentials: memoryCredentials{}}}
	challenges := make(chan string, 12)
	var workers sync.WaitGroup
	for range cap(challenges) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			result, err := desktop.dispatch("auth.begin", nil)
			if err != nil {
				test.Error(err)
				return
			}
			challenges <- result.(map[string]string)["google_url"]
		}()
	}
	workers.Wait()
	close(challenges)
	var original string
	for challenge := range challenges {
		if original == "" {
			original = challenge
		}
		if challenge != original {
			test.Fatal("concurrent resume replaced a pending challenge")
		}
	}
}

func TestPendingLoginExpiryAndExplicitRestart(test *testing.T) {
	for _, scenario := range []string{"resume", "activate", "expired", "restart", "different control"} {
		test.Run(scenario, func(test *testing.T) {
			now := time.Unix(1800000000, 0)
			desktop := &bridge{controlURL: "https://control.test", credentials: memoryCredentials{}, clock: func() time.Time { return now }}
			if _, err := desktop.dispatch("auth.begin", nil); err != nil {
				test.Fatal(err)
			}
			original, err := desktop.readPendingLogin(now)
			if err != nil {
				test.Fatal(err)
			}
			now = now.Add(time.Minute)
			var params json.RawMessage
			switch scenario {
			case "activate":
				params = json.RawMessage(`{"activate":true}`)
			case "restart":
				params = json.RawMessage(`{"restart":true}`)
			case "expired":
				now = time.Unix(original.ExpiresAt, 0)
			case "different control":
				desktop.controlURL = "https://other-control.test"
			}
			if _, err := desktop.dispatch("auth.begin", params); err != nil {
				test.Fatal(err)
			}
			pending, err := desktop.readPendingLogin(now)
			if err != nil {
				test.Fatal(err)
			}
			wantSame := scenario == "resume" || scenario == "activate"
			if (original.Verifier == pending.Verifier) != wantSame {
				test.Fatal("unexpected verifier rotation")
			}
			wantExpires := now.Add(pendingLoginTTL).Unix()
			if scenario == "resume" {
				wantExpires = original.ExpiresAt
			}
			if pending.ExpiresAt != wantExpires {
				test.Fatalf("expiry = %d, want %d", pending.ExpiresAt, wantExpires)
			}
		})
	}
}

func TestPendingLoginMigratesLegacyVerifier(test *testing.T) {
	verifier, _, err := newPKCE()
	if err != nil {
		test.Fatal(err)
	}
	store := memoryCredentials{credentialKey(credentialService, pkceCredential): verifier}
	desktop := &bridge{controlURL: "https://control.test", credentials: store}
	if _, err := desktop.dispatch("auth.begin", nil); err != nil {
		test.Fatal(err)
	}
	var persisted pendingLogin
	if err := json.Unmarshal([]byte(store[credentialKey(credentialService, pkceCredential)]), &persisted); err != nil {
		test.Fatal(err)
	}
	if persisted.Verifier != verifier || persisted.ExpiresAt <= persisted.CreatedAt {
		test.Fatal("legacy pending login was not preserved with a bounded expiry")
	}
}

func TestPendingLoginLegacyExchangeFailureKeepsFixedExpiry(test *testing.T) {
	verifier, _, err := newPKCE()
	if err != nil {
		test.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	now := time.Unix(1800000000, 0)
	store := memoryCredentials{credentialKey(credentialService, pkceCredential): verifier}
	desktop := &bridge{controlURL: server.URL, http: server.Client(), credentials: store, clock: func() time.Time { return now }}
	params := json.RawMessage(`{"code":"synthetic-code"}`)
	if _, err := desktop.dispatch("auth.exchange", params); err == nil {
		test.Fatal("expected first exchange failure")
	}
	original := store[credentialKey(credentialService, pkceCredential)]
	if original == verifier {
		test.Fatal("exchange-first legacy migration did not persist an expiry")
	}
	now = now.Add(pendingLoginTTL + time.Minute)
	if _, err := desktop.dispatch("auth.exchange", params); err == nil || err.Error() != "login session expired" {
		test.Fatalf("expired legacy retry = %v", err)
	}
	if requests.Load() != 1 || store[credentialKey(credentialService, pkceCredential)] != original {
		test.Fatal("expired retry refreshed the verifier lifetime or made another exchange request")
	}
}

func TestPendingLoginReadFailureDoesNotReplaceState(test *testing.T) {
	desktop := &bridge{controlURL: "https://control.test", credentials: failingCredentials{err: errors.New("credential store unavailable")}}
	if _, err := desktop.dispatch("auth.begin", nil); err == nil || !strings.Contains(err.Error(), "read login state") {
		test.Fatalf("expected credential read failure, got %v", err)
	}
}

func TestPendingLoginFailedExchangePreservesState(test *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	store := memoryCredentials{}
	desktop := &bridge{controlURL: server.URL, http: server.Client(), credentials: store}
	if _, err := desktop.dispatch("auth.begin", nil); err != nil {
		test.Fatal(err)
	}
	original := store[credentialKey(credentialService, pkceCredential)]
	if _, err := desktop.dispatch("auth.exchange", json.RawMessage(`{"code":"synthetic-code"}`)); err == nil {
		test.Fatal("expected exchange failure")
	}
	if store[credentialKey(credentialService, pkceCredential)] != original {
		test.Fatal("failed exchange changed pending login")
	}
	if _, err := store.Get(credentialService, jwtCredential); !errors.Is(err, keyring.ErrNotFound) {
		test.Fatal("failed exchange stored an account credential")
	}
}

func TestPendingLoginMagicExtendsSameAttempt(test *testing.T) {
	var sentChallenge string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body struct {
			Challenge string `json:"code_challenge"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			test.Error(err)
		}
		sentChallenge = body.Challenge
		_, _ = writer.Write([]byte(`{"sent":true,"expires_in":600,"retry_after":60}`))
	}))
	defer server.Close()
	now := time.Unix(1800000000, 0)
	desktop := &bridge{controlURL: server.URL, http: server.Client(), credentials: memoryCredentials{}, clock: func() time.Time { return now }}
	if _, err := desktop.dispatch("auth.begin", nil); err != nil {
		test.Fatal(err)
	}
	original, err := desktop.readPendingLogin(now)
	if err != nil {
		test.Fatal(err)
	}
	now = now.Add(10 * time.Minute)
	if _, err := desktop.dispatch("auth.magic", json.RawMessage(`{"email":"test@example.test"}`)); err != nil {
		test.Fatal(err)
	}
	pending, err := desktop.readPendingLogin(now)
	if err != nil {
		test.Fatal(err)
	}
	if sentChallenge != pkceChallenge(original.Verifier) || pending.Verifier != original.Verifier || pending.ExpiresAt != now.Add(pendingLoginTTL).Unix() {
		test.Fatal("sending a pending email must preserve its verifier and full callback lifetime")
	}
}
