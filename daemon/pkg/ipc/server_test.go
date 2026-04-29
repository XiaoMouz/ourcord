package ipc

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

type echoHandler struct{}

func (echoHandler) HandleIPC(ctx context.Context, req IPCRequest) IPCResponse {
	switch req.Cmd {
	case CmdPing:
		return IPCResponse{OK: true, Data: "pong"}
	default:
		return IPCResponse{OK: false, Error: "unknown cmd: " + req.Cmd}
	}
}

func startServer(t *testing.T) (*Server, string) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "test.sock")
	srv := NewServer(sock, echoHandler{})
	if err := srv.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		srv.Close()
	})
	go srv.Serve(ctx)
	// give Serve a moment to start accepting
	time.Sleep(50 * time.Millisecond)
	return srv, sock
}

func TestIPCPingPong(t *testing.T) {
	_, sock := startServer(t)
	cli, err := NewClient(sock)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer cli.Close()
	resp, err := cli.Call(CmdPing, nil)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if !resp.OK {
		t.Fatalf("expected ok, got error %q", resp.Error)
	}
	if resp.Data != "pong" {
		t.Errorf("expected pong, got %v", resp.Data)
	}
}

func TestIPCUnknownCmd(t *testing.T) {
	_, sock := startServer(t)
	cli, _ := NewClient(sock)
	defer cli.Close()
	resp, err := cli.Call("nonsense", nil)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if resp.OK {
		t.Errorf("expected !ok for unknown cmd")
	}
	if resp.Error == "" {
		t.Errorf("expected error message")
	}
}

func TestIPCMultipleRequests(t *testing.T) {
	_, sock := startServer(t)
	cli, _ := NewClient(sock)
	defer cli.Close()
	for i := 0; i < 5; i++ {
		resp, err := cli.Call(CmdPing, nil)
		if err != nil {
			t.Fatalf("Call %d: %v", i, err)
		}
		if !resp.OK {
			t.Fatalf("Call %d not ok: %s", i, resp.Error)
		}
	}
}

func TestIPCServerClose(t *testing.T) {
	srv, sock := startServer(t)
	cli, err := NewClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if _, err := cli.Call(CmdPing, nil); err != nil {
		t.Fatalf("first call: %v", err)
	}
	srv.Close()
	cli.Close()
	// second client should fail to dial
	if _, err := NewClient(sock); err == nil {
		t.Errorf("expected dial error after Close")
	}
}
