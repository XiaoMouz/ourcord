package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	pb "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
	"github.com/zalando/go-keyring"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type profileDaemonConn struct {
	grpc.ClientConnInterface
	enrolled     bool
	profileErr   error
	refreshErr   error
	refreshCalls int
}

func (c *profileDaemonConn) Invoke(_ context.Context, method string, _ any, reply any, _ ...grpc.CallOption) error {
	switch method {
	case pb.DaemonService_GetLocalProfile_FullMethodName:
		if c.profileErr != nil {
			return c.profileErr
		}
		reply.(*pb.GetLocalProfileResponse).Profile = &pb.LocalProfile{Enrolled: c.enrolled}
	case pb.DaemonService_RefreshSession_FullMethodName:
		c.refreshCalls++
		if !c.enrolled {
			// Same status/message as daemonService.RefreshSession when its
			// device token is absent on first launch or after unenrollment.
			return status.Error(codes.Unauthenticated, "device is not enrolled")
		}
		if c.refreshErr != nil {
			return c.refreshErr
		}
		reply.(*pb.RefreshSessionResponse).AccessToken = "daemon-jwt"
		reply.(*pb.RefreshSessionResponse).UserId = "user-1"
	default:
		return errors.New("unexpected daemon method: " + method)
	}
	return nil
}

func TestAuthStatusWithUnenrolledRunningDaemonIsLoggedOut(t *testing.T) {
	conn := &profileDaemonConn{}
	b := &bridge{credentials: memoryCredentials{}, stateDir: t.TempDir(), daemon: client.New(conn)}
	result, err := b.dispatch("auth.status", nil)
	if err != nil {
		t.Fatalf("first launch/after logout must reach the login screen: %v", err)
	}
	if result.(map[string]bool)["authenticated"] {
		t.Fatal("unenrolled daemon authenticated a user")
	}
	if conn.refreshCalls != 0 {
		t.Fatal("an unenrolled daemon must not attempt a session refresh")
	}
}

func TestAuthStatusStillRecoversAnEnrolledDaemonSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/me" || r.Header.Get("Authorization") != "Bearer daemon-jwt" {
			t.Errorf("unexpected profile request: %s, %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = io.WriteString(w, `{"user":{"id":"user-1"}}`)
	}))
	defer server.Close()
	conn := &profileDaemonConn{enrolled: true}
	store := memoryCredentials{}
	b := &bridge{
		credentials: store, stateDir: t.TempDir(), daemon: client.New(conn),
		controlURL: server.URL, http: server.Client(),
	}
	result, err := b.dispatch("auth.status", nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["authenticated"] != true || conn.refreshCalls != 1 {
		t.Fatalf("session not restored: %#v, calls=%d", result, conn.refreshCalls)
	}
	if token, _ := store.Get(credentialService, jwtCredential); token != "daemon-jwt" {
		t.Fatalf("stored JWT = %q", token)
	}
}

func TestAuthStatusDoesNotHideDaemonFailuresAsLogout(t *testing.T) {
	for _, stage := range []string{"profile", "refresh"} {
		t.Run(stage, func(t *testing.T) {
			conn := &profileDaemonConn{enrolled: true}
			failure := status.Error(codes.Unavailable, "temporary failure")
			if stage == "profile" {
				conn.profileErr = failure
			} else {
				conn.refreshErr = failure
			}
			store := memoryCredentials{}
			b := &bridge{credentials: store, stateDir: t.TempDir(), daemon: client.New(conn)}
			if _, err := b.dispatch("auth.status", nil); status.Code(err) != codes.Unavailable {
				t.Fatalf("failure was hidden: %v", err)
			}
			if _, err := store.Get(credentialService, jwtCredential); !errors.Is(err, keyring.ErrNotFound) {
				t.Fatal("a failed refresh must not write a credential")
			}
		})
	}
}
