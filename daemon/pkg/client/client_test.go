package client

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

// stubHandler is a minimal daemon IPC handler that returns typed payloads, so
// the client's decode path is exercised against the real socket transport.
type stubHandler struct{}

func (stubHandler) HandleIPC(_ context.Context, req ipc.IPCRequest) ipc.IPCResponse {
	switch req.Cmd {
	case ipc.CmdStatus:
		return ipc.IPCResponse{OK: true, Data: ipc.DaemonStatus{Running: true, VPNActive: true, IP4: "198.18.0.2", PeerCount: 1, PathSummary: "direct"}}
	case ipc.CmdListPeers:
		return ipc.IPCResponse{OK: true, Data: []ipc.ConnectedPeer{{PublicKey: "pk", Path: "direct", Direct: true}}}
	case ipc.CmdConnect, ipc.CmdDisconnect, ipc.CmdLeaveNetwork, ipc.CmdPing:
		return ipc.IPCResponse{OK: true}
	case ipc.CmdEnterNetwork:
		if req.Params["network_id"] == "" {
			return ipc.IPCResponse{OK: false, Error: "network_id required"}
		}
		return ipc.IPCResponse{OK: true}
	default:
		return ipc.IPCResponse{OK: false, Error: "unknown cmd: " + req.Cmd}
	}
}

func dialTest(t *testing.T) *Client {
	t.Helper()
	// Short prefix, not t.TempDir(): a long test name would overflow the ~104
	// char unix-socket path limit on macOS/BSD.
	dir, err := os.MkdirTemp("", "oc")
	if err != nil {
		t.Fatalf("tempdir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s")
	srv := ipc.NewServer(sock, stubHandler{})
	if err := srv.Listen(); err != nil {
		t.Fatalf("listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.Serve(ctx)
	time.Sleep(20 * time.Millisecond) // let Serve start accepting
	ic, err := ipc.NewClientWithSecret(sock, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := New(ic)
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestStatusDecodesTyped(t *testing.T) {
	st, err := dialTest(t).Status()
	if err != nil {
		t.Fatal(err)
	}
	if !st.VPNActive || st.IP4 != "198.18.0.2" || st.PathSummary != "direct" || st.PeerCount != 1 {
		t.Fatalf("unexpected status: %+v", st)
	}
}

func TestListPeersDecodesTyped(t *testing.T) {
	peers, err := dialTest(t).ListPeers()
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].Path != "direct" || !peers[0].Direct {
		t.Fatalf("unexpected peers: %+v", peers)
	}
}

func TestMutatingSucceeds(t *testing.T) {
	c := dialTest(t)
	for _, op := range []func() error{c.Connect, func() error { return c.EnterNetwork("lobby-x-voice") }, c.Ping, c.Disconnect} {
		if err := op(); err != nil {
			t.Fatalf("mutating op: %v", err)
		}
	}
}

func TestDaemonRejectionSurfacesAsError(t *testing.T) {
	err := dialTest(t).EnterNetwork("")
	if err == nil {
		t.Fatal("expected an error for empty network_id")
	}
	var de *DaemonError
	if !asDaemonError(err, &de) || de.Msg != "network_id required" {
		t.Fatalf("expected DaemonError with daemon message, got %v", err)
	}
}

// asDaemonError is a tiny errors.As shim kept local to avoid an import just for
// one assertion.
func asDaemonError(err error, target **DaemonError) bool {
	de, ok := err.(*DaemonError)
	if ok {
		*target = de
	}
	return ok
}
