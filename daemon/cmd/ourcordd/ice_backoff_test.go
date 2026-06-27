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
