package client

import (
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/grpc"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	ourcordv1 "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
)

func TestDialNamedPipeRoundTrip(t *testing.T) {
	if ipc.UsesHMACAuth() {
		t.Fatal("Windows service clients must use named-pipe OS authentication")
	}
	directory, err := os.MkdirTemp("", "ourcord-pipe")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	pipe := `\\.\pipe\ourcord-client-` + filepath.Base(directory)
	listener, err := ipc.ListenAuthenticated(pipe, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	ourcordv1.RegisterDaemonServiceServer(server, stubServer{})
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	connection, err := Dial(pipe)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	status, err := connection.Status()
	if err != nil || !status.VPNActive {
		t.Fatalf("status over production named-pipe dial: %+v err=%v", status, err)
	}
}
