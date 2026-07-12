package client

import (
	"context"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

// Snapshot is a point-in-time view of the daemon for a UI to render. A failed
// poll sets Err (and leaves Status/Peers zero) rather than ending the stream, so
// a UI can show "daemon unavailable" and recover when it returns.
type Snapshot struct {
	Status ipc.DaemonStatus
	Peers  []ipc.ConnectedPeer
	Err    error
	At     time.Time
}

// Watch polls the daemon at socketPath every interval and delivers Snapshots on
// the returned channel until ctx is cancelled (which closes the channel). It
// owns its own connection: it dials lazily, and on any poll error it drops the
// connection and re-dials on the next tick, so the stream survives a daemon
// restart. The first snapshot is delivered immediately, not after one interval.
//
// This is the shared view-model both the CLI live view and the TUI consume, so
// polling/reconnect logic lives once in the core, not per-presenter.
func Watch(ctx context.Context, socketPath string, interval time.Duration) <-chan Snapshot {
	return watchWith(ctx, func() (*Client, error) { return Dial(socketPath) }, interval)
}

// watchWith is Watch with an injectable dialer so tests can connect without the
// machine's IPC HMAC key.
func watchWith(ctx context.Context, dial func() (*Client, error), interval time.Duration) <-chan Snapshot {
	if interval <= 0 {
		interval = time.Second // NewTicker panics on non-positive intervals
	}
	ch := make(chan Snapshot, 1)
	go func() {
		defer close(ch)
		var c *Client
		defer func() {
			if c != nil {
				_ = c.Close()
			}
		}()

		poll := func() Snapshot {
			snap := Snapshot{At: time.Now()}
			if c == nil {
				nc, err := dial()
				if err != nil {
					snap.Err = err
					return snap
				}
				c = nc
			}
			st, err := c.Status()
			if err != nil {
				_ = c.Close()
				c = nil // force a re-dial next tick
				snap.Err = err
				return snap
			}
			peers, err := c.ListPeers()
			if err != nil {
				_ = c.Close()
				c = nil
				snap.Err = err
				return snap
			}
			snap.Status, snap.Peers = st, peers
			return snap
		}
		send := func(s Snapshot) bool {
			select {
			case ch <- s:
				return true
			case <-ctx.Done():
				return false
			}
		}

		if !send(poll()) {
			return
		}
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !send(poll()) {
					return
				}
			}
		}
	}()
	return ch
}
