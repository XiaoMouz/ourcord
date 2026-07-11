package main

import (
	"context"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/routing"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func TestScheduleICERetryDoublesAndCaps(t *testing.T) {
	d := &daemon{}
	pk := mustTestKey(0x51)

	d.scheduleICERetryLocked(pk)
	st := d.iceRetry[pk]
	if st == nil || st.interval != iceRetryBase {
		t.Fatalf("first schedule interval = %v, want %v", st, iceRetryBase)
	}

	// Exponential doubling for the first few failures.
	for _, want := range []time.Duration{iceRetryBase * 2, iceRetryBase * 4, iceRetryBase * 8} {
		d.scheduleICERetryLocked(pk)
		if st.interval != want {
			t.Fatalf("interval = %v, want %v", st.interval, want)
		}
	}

	// Eventually it caps and never exceeds the ceiling.
	for i := 0; i < 20; i++ {
		d.scheduleICERetryLocked(pk)
		if st.interval > iceRetryCap {
			t.Fatalf("interval %v exceeded cap %v", st.interval, iceRetryCap)
		}
	}
	if st.interval != iceRetryCap {
		t.Fatalf("interval should settle at cap %v, got %v", iceRetryCap, st.interval)
	}
}

func TestICERetryAttemptBacksOffNextAttempt(t *testing.T) {
	now := time.Unix(1_000, 0)
	st := &iceRetryState{interval: iceRetryBase}

	st.backoffAfterAttempt(now)
	if st.interval != 2*iceRetryBase {
		t.Fatalf("interval after first retry = %v, want %v", st.interval, 2*iceRetryBase)
	}
	if !st.nextAttempt.Equal(now.Add(2 * iceRetryBase)) {
		t.Fatalf("next attempt = %v, want %v", st.nextAttempt, now.Add(2*iceRetryBase))
	}

	st.backoffAfterAttempt(now)
	if st.interval != 4*iceRetryBase {
		t.Fatalf("interval after second retry = %v, want %v", st.interval, 4*iceRetryBase)
	}
	if !st.nextAttempt.Equal(now.Add(4 * iceRetryBase)) {
		t.Fatalf("next attempt = %v, want %v", st.nextAttempt, now.Add(4*iceRetryBase))
	}
}

func TestResetICEBackoffPullsToBaseAndDue(t *testing.T) {
	d := &daemon{}
	pk := mustTestKey(0x53)
	d.scheduleICERetryLocked(pk)
	d.scheduleICERetryLocked(pk)
	d.scheduleICERetryLocked(pk) // backed off well past base

	d.resetICEBackoffLocked()

	st := d.iceRetry[pk]
	if st.interval != iceRetryBase {
		t.Fatalf("reset interval = %v, want %v", st.interval, iceRetryBase)
	}
	if st.nextAttempt.After(time.Now()) {
		t.Fatalf("reset must make the retry due now, nextAttempt = %v", st.nextAttempt)
	}
}

func TestHasNewPeerDetectsJoinOnly(t *testing.T) {
	a := mustTestKey(0x54)
	b := mustTestKey(0x55)

	before := peerKeySet([]*routing.PeerRoute{{PublicKey: a}})
	if hasNewPeer(before, []*routing.PeerRoute{{PublicKey: a}}) {
		t.Fatal("no membership change must not report a new peer")
	}
	if !hasNewPeer(before, []*routing.PeerRoute{{PublicKey: a}, {PublicKey: b}}) {
		t.Fatal("a joining peer must be detected")
	}

	beforeBoth := peerKeySet([]*routing.PeerRoute{{PublicKey: a}, {PublicKey: b}})
	if hasNewPeer(beforeBoth, []*routing.PeerRoute{{PublicKey: a}}) {
		t.Fatal("a leaving peer must not be treated as a join")
	}
}

func TestRetryDegradedICENoopWhenDisabled(t *testing.T) {
	// With ICE disabled the retry driver must not touch the (nil) ICE manager.
	d := &daemon{disableICE: true, table: routing.NewTable()}
	d.table.Upsert(&routing.PeerRoute{PublicKey: mustTestKey(0x56), LastError: "direct-health-lost"})
	d.iceRetry = map[wgtypes.Key]*iceRetryState{mustTestKey(0x56): {interval: iceRetryBase, nextAttempt: time.Now().Add(-time.Second)}}
	d.retryDegradedICE(context.Background())
}

func TestCollectICERetryIncludesNextHopRecovery(t *testing.T) {
	now := time.Unix(2_000, 0)
	peer := mustTestKey(0x57)
	hop := mustTestKey(0x58)
	d := &daemon{table: routing.NewTable()}
	d.table.Upsert(&routing.PeerRoute{
		PublicKey: peer,
		NextHop:   &hop,
	})

	got := d.collectICERetryLocked(now)
	if len(got) != 1 || got[0] != peer.String() {
		t.Fatalf("retry keys = %v, want next-hop peer %s", got, peer.String())
	}
	st := d.iceRetry[peer]
	if st == nil {
		t.Fatal("next-hop recovery should create retry state")
	}
	if !st.nextAttempt.After(now) {
		t.Fatalf("next attempt should back off after probe, got %v", st.nextAttempt)
	}
}

func TestCollectICERetrySkipsHealthyDirectPeer(t *testing.T) {
	now := time.Unix(3_000, 0)
	peer := mustTestKey(0x59)
	d := &daemon{
		table: routing.NewTable(),
		iceRetry: map[wgtypes.Key]*iceRetryState{
			peer: {interval: iceRetryBase, nextAttempt: now.Add(-time.Second)},
		},
	}
	d.table.Upsert(&routing.PeerRoute{PublicKey: peer})

	if got := d.collectICERetryLocked(now); len(got) != 0 {
		t.Fatalf("healthy direct peer must not retry, got %v", got)
	}
}

func TestScheduleICERetryDampsFlappingPeer(t *testing.T) {
	pk := mustTestKey(0x5a)
	d := &daemon{pathState: map[wgtypes.Key]*peerPathState{pk: {flapping: true}}}

	before := time.Now()
	d.scheduleICERetryLocked(pk)
	st := d.iceRetry[pk]
	if st == nil {
		t.Fatal("schedule should create retry state")
	}
	// A flapping peer's first attempt is pushed out to the damp floor, well past
	// the base interval a stable peer would get.
	if got := st.nextAttempt.Sub(before); got < flapDampInterval {
		t.Fatalf("flapping first attempt delay = %v, want >= %v", got, flapDampInterval)
	}

	// A non-flapping peer gets the ordinary base interval — far shorter.
	stable := mustTestKey(0x5b)
	d2 := &daemon{}
	beforeStable := time.Now()
	d2.scheduleICERetryLocked(stable)
	if got := d2.iceRetry[stable].nextAttempt.Sub(beforeStable); got >= flapDampInterval {
		t.Fatalf("stable first attempt delay = %v, should be < %v", got, flapDampInterval)
	}
}

func TestCollectICERetryHoldsFlappingNextHopPeer(t *testing.T) {
	now := time.Unix(5_000, 0)
	peer := mustTestKey(0x5c)
	hop := mustTestKey(0x5d)
	d := &daemon{
		table:     routing.NewTable(),
		pathState: map[wgtypes.Key]*peerPathState{peer: {flapping: true}},
	}
	d.table.Upsert(&routing.PeerRoute{PublicKey: peer, NextHop: &hop})

	// The peer needs recovery, but because it is flapping the first probe is
	// deferred to the damp floor rather than fired this tick.
	if got := d.collectICERetryLocked(now); len(got) != 0 {
		t.Fatalf("flapping peer must be held this tick, got %v", got)
	}
	st := d.iceRetry[peer]
	if st == nil || st.nextAttempt.Before(now.Add(flapDampInterval)) {
		t.Fatalf("flapping next-hop peer should defer to damp floor, got %+v", st)
	}
}
