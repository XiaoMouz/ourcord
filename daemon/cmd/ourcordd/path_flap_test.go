package main

import (
	"net/netip"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/routing"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// derpRoute builds a peer that starts on the DERP baseline path ("derp"): it has
// a relay but no ICE and no error. Toggling ICEReady/DERPFallback then moves its
// routePath() between "direct" and "degraded" so transitions are deterministic.
func derpRoute(pk wgtypes.Key, ip string) *routing.PeerRoute {
	return &routing.PeerRoute{
		PublicKey:   pk,
		VPN4:        netip.MustParseAddr(ip),
		DERPURL:     "https://relay.example.com/derp",
		DERPNodeKey: "nodekey:0123456789abcdef",
	}
}

func TestObservePathTransitionsCountsOnlyChanges(t *testing.T) {
	pk := mustTestKey(0x71)
	tbl := routing.NewTable()
	tbl.Upsert(derpRoute(pk, "198.18.0.71"))
	d := &daemon{table: tbl}
	base := time.Unix(1_000_000, 0)

	// First sample establishes the baseline — not a transition.
	d.observePathTransitionsLocked(base)
	if st := d.pathState[pk]; st == nil || st.transitions != 0 || st.lastPath != "derp" {
		t.Fatalf("baseline state = %+v, want derp with 0 transitions", d.pathState[pk])
	}

	// Re-sampling the same path must not count.
	d.observePathTransitionsLocked(base.Add(time.Second))
	if d.pathState[pk].transitions != 0 {
		t.Fatalf("stable path counted a transition: %d", d.pathState[pk].transitions)
	}

	// derp → direct is one transition; dwell resets to the change time.
	tbl.SetICEReady(pk, true)
	change := base.Add(2 * time.Second)
	d.observePathTransitionsLocked(change)
	st := d.pathState[pk]
	if st.transitions != 1 || st.lastPath != "direct" || !st.lastChange.Equal(change) {
		t.Fatalf("after derp→direct: %+v, want 1 transition to direct at %v", st, change)
	}
}

func TestObservePathTransitionsFlapsAndDrains(t *testing.T) {
	pk := mustTestKey(0x72)
	tbl := routing.NewTable()
	tbl.Upsert(derpRoute(pk, "198.18.0.72"))
	d := &daemon{table: tbl}
	base := time.Unix(2_000_000, 0)
	d.observePathTransitionsLocked(base) // baseline "derp"

	// Toggle direct↔degraded four times inside the window → flapping.
	for i := 1; i <= flapThreshold; i++ {
		if i%2 == 1 {
			tbl.SetICEReady(pk, true)
		} else {
			tbl.SetDERPFallback(pk, "direct-health-lost")
		}
		d.observePathTransitionsLocked(base.Add(time.Duration(i) * time.Second))
	}
	st := d.pathState[pk]
	if !st.flapping || st.transitions != uint64(flapThreshold) {
		t.Fatalf("expected flapping with %d transitions, got %+v", flapThreshold, st)
	}
	if len(st.window) != flapThreshold {
		t.Fatalf("window length = %d, want %d", len(st.window), flapThreshold)
	}

	// One more change well past flapWindow drains the stale timestamps: the
	// window holds only the newest change, so the peer is no longer flapping —
	// but the total transition count keeps climbing.
	tbl.SetICEReady(pk, true)
	late := base.Add(flapWindow + 10*time.Second)
	d.observePathTransitionsLocked(late)
	st = d.pathState[pk]
	if st.flapping {
		t.Fatalf("peer should stop flapping after the window drains: %+v", st)
	}
	if st.transitions != uint64(flapThreshold+1) {
		t.Fatalf("transitions = %d, want %d (monotonic)", st.transitions, flapThreshold+1)
	}
	if len(st.window) != 1 {
		t.Fatalf("drained window length = %d, want 1", len(st.window))
	}
}

func TestFlapStateNextHysteresis(t *testing.T) {
	// Set: reaching the threshold flips on regardless of prior state.
	if !flapStateNext(false, flapThreshold) || !flapStateNext(true, flapThreshold) {
		t.Fatal("windowLen >= flapThreshold must set flapping")
	}
	// Hold: once flapping, a window pruned just below the threshold must NOT
	// clear the flag — this is the marginal 3↔4 oscillation being damped.
	for n := flapThreshold - 1; n > flapClearThreshold; n-- {
		if !flapStateNext(true, n) {
			t.Fatalf("flapping must hold at windowLen=%d (clear bound %d)", n, flapClearThreshold)
		}
	}
	// Clear: only a drained window releases the flag.
	if flapStateNext(true, flapClearThreshold) || flapStateNext(true, 0) {
		t.Fatal("flapping must clear once the window drains to <= flapClearThreshold")
	}
	// A non-flapping peer below the set threshold stays clear (no re-arm from
	// an isolated transition).
	if flapStateNext(false, flapThreshold-1) || flapStateNext(false, 1) {
		t.Fatal("sub-threshold window must not set flapping")
	}
}

func TestFlapHysteresisHoldsThroughMarginalPrune(t *testing.T) {
	pk := mustTestKey(0x75)
	tbl := routing.NewTable()
	tbl.Upsert(derpRoute(pk, "198.18.0.75"))
	d := &daemon{table: tbl}
	base := time.Unix(3_000_000, 0)
	d.observePathTransitionsLocked(base) // baseline "derp"

	// Four quick toggles → flapping.
	for i := 1; i <= flapThreshold; i++ {
		if i%2 == 1 {
			tbl.SetICEReady(pk, true)
		} else {
			tbl.SetDERPFallback(pk, "direct-health-lost")
		}
		d.observePathTransitionsLocked(base.Add(time.Duration(i) * time.Second))
	}
	if !d.pathState[pk].flapping {
		t.Fatal("expected flapping after threshold toggles")
	}

	// Quiet ticks prune the window to 3, then 2 — pre-hysteresis this cleared
	// the flag (and released the ICE damp) the moment it dipped under 4.
	d.observePathTransitionsLocked(base.Add(flapWindow + 2*time.Second)) // keeps transitions at 3s,4s → len 2..3
	st := d.pathState[pk]
	if len(st.window) >= flapThreshold {
		t.Fatalf("test premise broken: window should have pruned below threshold, len=%d", len(st.window))
	}
	if !st.flapping {
		t.Fatalf("flapping must hold while the window is only partially drained (len=%d)", len(st.window))
	}

	// Once the window fully drains past the clear bound, the flag releases.
	d.observePathTransitionsLocked(base.Add(flapWindow + time.Duration(flapThreshold+1)*time.Second))
	st = d.pathState[pk]
	if len(st.window) > flapClearThreshold {
		t.Fatalf("test premise broken: window should have drained to <=%d, len=%d", flapClearThreshold, len(st.window))
	}
	if st.flapping {
		t.Fatalf("flapping must clear after the window drains (len=%d)", len(st.window))
	}
}

func TestPathTelemetrySnapshotDwellAndRollup(t *testing.T) {
	a, b := mustTestKey(0x73), mustTestKey(0x74)
	tbl := routing.NewTable()
	tbl.Upsert(derpRoute(a, "198.18.0.73"))
	tbl.Upsert(derpRoute(b, "198.18.0.74"))
	d := &daemon{table: tbl}
	base := time.Unix(3_000_000, 0)
	d.observePathTransitionsLocked(base)

	// Move only peer a: derp → direct at base+5s.
	tbl.SetICEReady(a, true)
	d.observePathTransitionsLocked(base.Add(5 * time.Second))

	snap, total := d.pathTelemetrySnapshotLocked(base.Add(35 * time.Second))
	if total != 1 {
		t.Fatalf("rollup = %d, want 1 (only peer a moved)", total)
	}
	if ta := snap[a.String()]; ta.transitions != 1 || ta.dwellSecs != 30 || ta.flapping {
		t.Fatalf("peer a telem = %+v, want 1 transition / 30s dwell / not flapping", ta)
	}
	if tb := snap[b.String()]; tb.transitions != 0 {
		t.Fatalf("peer b telem = %+v, want 0 transitions", tb)
	}
}

func TestObservePathTransitionsPrunesDepartedPeers(t *testing.T) {
	a, b := mustTestKey(0x75), mustTestKey(0x76)
	tbl := routing.NewTable()
	tbl.Upsert(derpRoute(a, "198.18.0.75"))
	tbl.Upsert(derpRoute(b, "198.18.0.76"))
	d := &daemon{table: tbl}
	base := time.Unix(4_000_000, 0)
	d.observePathTransitionsLocked(base)
	if len(d.pathState) != 2 {
		t.Fatalf("expected 2 tracked peers, got %d", len(d.pathState))
	}

	// Peer b leaves the network: its state must be dropped so the map can't grow.
	only := routing.NewTable()
	only.Upsert(derpRoute(a, "198.18.0.75"))
	d.table = only
	d.observePathTransitionsLocked(base.Add(time.Second))
	if _, ok := d.pathState[b]; ok {
		t.Fatalf("departed peer b was not pruned from pathState")
	}
	if _, ok := d.pathState[a]; !ok {
		t.Fatalf("present peer a should remain tracked")
	}
}
