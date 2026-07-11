package main

import (
	"context"
	"log"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Path-flap telemetry. The daemon already tries to *reduce* flap (sustained ICE
// probe, exponential re-upgrade backoff, DERP baseline); this samples the
// derived path label per peer so churn is measurable, surfaced on the status
// contract, and fed back into the ICE backoff to damp a chronically-unstable
// peer instead of re-upgrading it on every tick.
const (
	flapObserveTick  = 2 * time.Second
	flapWindow       = 60 * time.Second
	flapThreshold    = 4               // ≥ this many transitions inside flapWindow ⇒ flapping
	flapDampInterval = 2 * time.Minute // backoff floor applied to a flapping peer (≤ iceRetryCap)
)

// peerPathState tracks one peer's effective-path history. Guarded by connMu.
type peerPathState struct {
	lastPath    string      // last observed routePath()
	lastChange  time.Time   // when lastPath last changed → dwell
	transitions uint64      // total transitions since the peer was first observed
	window      []time.Time // transition timestamps still inside flapWindow
	flapping    bool        // window length ≥ flapThreshold
}

// pathTelem is a lock-free snapshot of a peer's flap telemetry for the IPC layer.
type pathTelem struct {
	transitions uint64
	dwellSecs   int64
	flapping    bool
}

// observePathTransitionsLocked samples routePath() for every current peer and
// folds transitions into pathState. Caller holds connMu and has checked table.
func (d *daemon) observePathTransitionsLocked(now time.Time) {
	if d.table == nil {
		return
	}
	if d.pathState == nil {
		d.pathState = make(map[wgtypes.Key]*peerPathState)
	}
	seen := make(map[wgtypes.Key]struct{})
	for _, r := range d.table.All() {
		if r == nil {
			continue
		}
		seen[r.PublicKey] = struct{}{}
		path := routePath(r)
		st := d.pathState[r.PublicKey]
		if st == nil {
			// First observation establishes a baseline; it is not a transition.
			d.pathState[r.PublicKey] = &peerPathState{lastPath: path, lastChange: now}
			continue
		}
		st.window = pruneWindow(st.window, now.Add(-flapWindow))
		if path == st.lastPath {
			st.flapping = len(st.window) >= flapThreshold
			continue
		}
		log.Printf("peer path flap: %s %s→%s count=%d", r.PublicKey.String()[:12], st.lastPath, path, st.transitions+1)
		st.lastPath = path
		st.lastChange = now
		st.transitions++
		st.window = append(st.window, now)
		st.flapping = len(st.window) >= flapThreshold
	}
	// Drop state for peers that left the network so the map can't grow unbounded.
	for pk := range d.pathState {
		if _, ok := seen[pk]; !ok {
			delete(d.pathState, pk)
		}
	}
}

// pruneWindow drops timestamps at or before cutoff, keeping the slice's tail.
func pruneWindow(window []time.Time, cutoff time.Time) []time.Time {
	i := 0
	for i < len(window) && !window[i].After(cutoff) {
		i++
	}
	return window[i:]
}

// pathTelemetrySnapshotLocked builds a per-peer telemetry snapshot (keyed by the
// public-key string the IPC layer uses) plus the summed transition rollup.
// Caller holds connMu.
func (d *daemon) pathTelemetrySnapshotLocked(now time.Time) (map[string]pathTelem, uint64) {
	snap := make(map[string]pathTelem, len(d.pathState))
	var total uint64
	for pk, st := range d.pathState {
		total += st.transitions
		dwell := int64(now.Sub(st.lastChange) / time.Second)
		if dwell < 0 {
			dwell = 0
		}
		snap[pk.String()] = pathTelem{transitions: st.transitions, dwellSecs: dwell, flapping: st.flapping}
	}
	return snap, total
}

// peerFlappingLocked reports whether a peer is currently flapping. Caller holds
// connMu. Used to damp the ICE re-upgrade backoff.
func (d *daemon) peerFlappingLocked(pk wgtypes.Key) bool {
	st := d.pathState[pk]
	return st != nil && st.flapping
}

// enrichPeerTelemetry fills the flap fields on a ConnectedPeer list from a
// snapshot. Kept free-standing so connectedPeers stays pure for its unit tests.
func enrichPeerTelemetry(peers []ipc.ConnectedPeer, telem map[string]pathTelem) {
	for i := range peers {
		if t, ok := telem[peers[i].PublicKey]; ok {
			peers[i].PathTransitions = t.transitions
			peers[i].PathDwellSecs = t.dwellSecs
			peers[i].Flapping = t.flapping
		}
	}
}

// pathFlapLoop samples path transitions on a short cadence for the lifetime of a
// connection. Mirrors iceRetryLoop / reachabilityLoop.
func (d *daemon) pathFlapLoop(ctx context.Context) {
	t := time.NewTicker(flapObserveTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			d.connMu.Lock()
			d.observePathTransitionsLocked(time.Now())
			d.connMu.Unlock()
		}
	}
}
