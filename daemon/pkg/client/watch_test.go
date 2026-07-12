package client

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func TestWatchDeliversSnapshotsAndClosesOnCancel(t *testing.T) {
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
	sctx, scancel := context.WithCancel(context.Background())
	t.Cleanup(scancel)
	go srv.Serve(sctx)
	time.Sleep(20 * time.Millisecond)

	ctx, cancel := context.WithCancel(context.Background())
	// Dial without the machine HMAC key (the stub server has none).
	dial := func() (*Client, error) {
		ic, err := ipc.NewClientWithSecret(sock, nil)
		if err != nil {
			return nil, err
		}
		return New(ic), nil
	}
	ch := watchWith(ctx, dial, 20*time.Millisecond)

	// First snapshot is immediate and carries a decoded status.
	snap := <-ch
	if snap.Err != nil || !snap.Status.VPNActive || len(snap.Peers) != 1 {
		t.Fatalf("unexpected first snapshot: %+v", snap)
	}
	// At least one more arrives on the tick.
	select {
	case snap = <-ch:
		if snap.Err != nil {
			t.Fatalf("second snapshot error: %v", snap.Err)
		}
	case <-time.After(time.Second):
		t.Fatal("no second snapshot within 1s")
	}

	// Cancelling closes the channel.
	cancel()
	deadline := time.After(time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return // closed — success
			}
		case <-deadline:
			t.Fatal("channel not closed after cancel")
		}
	}
}

func TestWatchEmitsErrorWhenDaemonUnavailable(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch := Watch(ctx, filepath.Join(t.TempDir(), "absent.sock"), time.Second)
	snap := <-ch
	if snap.Err == nil {
		t.Fatal("expected an error snapshot when the daemon socket is absent")
	}
}
