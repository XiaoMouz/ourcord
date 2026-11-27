package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	pb "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
	"github.com/zalando/go-keyring"
	"google.golang.org/grpc"
)

type lockedCredentials struct {
	mu sync.Mutex
	memoryCredentials
}

func (s *lockedCredentials) Get(service, user string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.memoryCredentials.Get(service, user)
}
func (s *lockedCredentials) Set(service, user, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.memoryCredentials.Set(service, user, value)
}
func (s *lockedCredentials) Delete(service, user string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.memoryCredentials.Delete(service, user)
}

// Exercise the actual client wrapper used during logout without a privileged
// local daemon. The daemon refresh has its own JWT, independent of the pending
// HTTP device exchange in the background lobby poll.
type logoutDaemonConn struct{ grpc.ClientConnInterface }

func (logoutDaemonConn) Invoke(_ context.Context, method string, _ any, reply any, _ ...grpc.CallOption) error {
	switch method {
	case pb.DaemonService_GetLocalProfile_FullMethodName:
		reply.(*pb.GetLocalProfileResponse).Profile = &pb.LocalProfile{DeviceId: "device-1", Enrolled: true}
	case pb.DaemonService_RefreshSession_FullMethodName:
		reply.(*pb.RefreshSessionResponse).AccessToken = "logout-jwt"
		reply.(*pb.RefreshSessionResponse).UserId = "user-1"
	case pb.DaemonService_UnenrollDevice_FullMethodName:
		reply.(*pb.UnenrollDeviceResponse).Result = &pb.OperationResult{Ok: true}
	default:
		return errors.New("unexpected daemon method: " + method)
	}
	return nil
}

func TestLogoutCannotBeUndoneByPendingAccountRefresh(t *testing.T) {
	store := &lockedCredentials{memoryCredentials: memoryCredentials{
		credentialKey(credentialService, jwtCredential):    "expired-jwt",
		credentialKey(credentialService, deviceCredential): "dt_device",
		credentialKey(credentialService, pkceCredential):   "pending-login-verifier",
	}}
	refreshStarted := make(chan struct{})
	releaseRefresh := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseRefresh) }) }
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/lobbies":
			if r.Header.Get("Authorization") == "Bearer expired-jwt" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":"expired"}`)
				return
			}
			_, _ = io.WriteString(w, `{"lobbies":[]}`)
		case "/api/auth/device":
			close(refreshStarted)
			<-releaseRefresh
			_, _ = io.WriteString(w, `{"token":"background-jwt"}`)
		case "/api/devices/device-1", "/api/presence":
			if r.Header.Get("Authorization") != "Bearer logout-jwt" {
				t.Error("logout must use the daemon-refreshed token")
			}
			_, _ = io.WriteString(w, `{}`)
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	defer release()
	b := &bridge{
		controlURL: server.URL, serviceURL: server.URL, http: server.Client(),
		credentials: store, stateDir: t.TempDir(),
		daemon: client.New(logoutDaemonConn{}),
	}
	pollDone := make(chan error, 1)
	go func() { _, err := b.dispatch("lobbies.list", nil); pollDone <- err }()
	select {
	case <-refreshStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("background poll did not reach credential refresh")
	}
	logoutDone := make(chan error, 1)
	go func() { _, err := b.dispatch("auth.logout", nil); logoutDone <- err }()

	// The old implementation completes logout while refresh is still pending.
	// A serialized implementation may wait; release it after this observation.
	logoutFinished := false
	select {
	case err := <-logoutDone:
		if err != nil {
			t.Fatal(err)
		}
		logoutFinished = true
	case <-time.After(100 * time.Millisecond):
	}
	release()
	if err := <-pollDone; err != nil {
		t.Fatal(err)
	}
	if !logoutFinished {
		if err := <-logoutDone; err != nil {
			t.Fatal(err)
		}
	}
	for _, credential := range []string{jwtCredential, deviceCredential, pkceCredential} {
		if value, err := store.Get(credentialService, credential); !errors.Is(err, keyring.ErrNotFound) {
			t.Errorf("%s present after logout: %q (%v)", credential, value, err)
		}
	}
	if _, _, err := b.apiWithAccount(http.MethodGet, server.URL, "/api/lobbies", nil); err == nil {
		t.Fatal("a logged-out client must not authenticate another lobby poll")
	}
}

func TestAccountRequestsRemainConcurrent(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-release
		_, _ = io.WriteString(w, `{"lobbies":[]}`)
	}))
	defer server.Close()
	done := make(chan error, 2)
	defer func() {
		close(release)
		for range 2 {
			if err := <-done; err != nil {
				t.Error(err)
			}
		}
	}()
	b := &bridge{
		serviceURL: server.URL, http: server.Client(),
		credentials: &lockedCredentials{memoryCredentials: memoryCredentials{
			credentialKey(credentialService, jwtCredential): "valid-jwt",
		}},
	}
	for range 2 {
		go func() { _, err := b.dispatch("lobbies.list", nil); done <- err }()
	}
	for range 2 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("account requests were unnecessarily serialized")
		}
	}
}

func TestDaemonProfileRemainsAvailableDuringLogout(t *testing.T) {
	release := make(chan struct{})
	revoking := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/devices/device-1" {
			close(revoking)
			<-release
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	b := &bridge{
		serviceURL: server.URL, controlURL: server.URL, http: server.Client(), stateDir: t.TempDir(),
		daemon: client.New(logoutDaemonConn{}),
		credentials: &lockedCredentials{memoryCredentials: memoryCredentials{
			credentialKey(credentialService, jwtCredential): "valid-jwt",
		}},
	}
	logoutDone := make(chan error, 1)
	defer func() {
		close(release)
		if err := <-logoutDone; err != nil {
			t.Error(err)
		}
	}()
	go func() { _, err := b.dispatch("auth.logout", nil); logoutDone <- err }()
	select {
	case <-revoking:
	case <-time.After(5 * time.Second):
		t.Fatal("logout did not reach device revocation")
	}
	profileDone := make(chan error, 1)
	go func() { _, err := b.dispatch("daemon.profile", nil); profileDone <- err }()
	select {
	case err := <-profileDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon status was blocked by a logout HTTP request")
	}
}
