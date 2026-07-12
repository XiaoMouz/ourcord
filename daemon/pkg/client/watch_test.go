package client

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestWatchDeliversSnapshotsAndClosesOnCancel(t *testing.T) {
	c := dialStub(t)
	ctx, cancel := context.WithCancel(context.Background())
	// Reuse one stub-backed client for every "dial" — Watch only needs a
	// working Client; production Dial wiring is covered by
	// TestDialAuthenticatedRoundTrip.
	dial := func() (*Client, error) { return c, nil }
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
