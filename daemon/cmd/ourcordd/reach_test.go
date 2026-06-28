package main

import (
	"context"
	"encoding/hex"
	"net/netip"
	"strconv"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/control"
	"github.com/ourcord/ourcord/daemon/pkg/routing"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func TestReachableFromSample(t *testing.T) {
	now := time.Unix(1_000_000, 0).Unix()

	// Fresh handshake: alive regardless of rx.
	if !reachableFromSample(100, true, peerLiveness{lastHandshakeSec: now - 10, rxBytes: 100}, now, reachStaleSec) {
		t.Fatal("a recent handshake must count as reachable")
	}
	// Stale handshake but rx grew (a keepalive arrived): alive.
	if !reachableFromSample(100, true, peerLiveness{lastHandshakeSec: now - 10_000, rxBytes: 132}, now, reachStaleSec) {
		t.Fatal("growing rx_bytes must count as reachable")
	}
	// Stale handshake and flat rx: not alive this sample.
	if reachableFromSample(132, true, peerLiveness{lastHandshakeSec: now - 10_000, rxBytes: 132}, now, reachStaleSec) {
		t.Fatal("stale handshake + flat rx must not count as reachable")
	}
	// Never handshaked, no prior rx sample: not alive.
	if reachableFromSample(0, false, peerLiveness{lastHandshakeSec: 0, rxBytes: 0}, now, reachStaleSec) {
		t.Fatal("a never-handshaked peer must not count as reachable")
	}
}

func TestFlagUnreachable(t *testing.T) {
	now := time.Unix(2_000_000, 0)
	grace := int64(reachGraceSec)
	stale := int64(reachStaleSec)

	// Within grace window: never flag, even with no progress.
	if flagUnreachable(now.Add(-10*time.Second), now.Add(-10*time.Second), now, grace, stale) {
		t.Fatal("must not flag a peer still inside the initial grace window")
	}
	// Past grace but progress was recent: not yet unreachable.
	if flagUnreachable(now.Add(-5*time.Minute), now.Add(-20*time.Second), now, grace, stale) {
		t.Fatal("recent progress must keep a peer reachable")
	}
	// Past grace and no progress beyond the stale window: unreachable.
	if !flagUnreachable(now.Add(-5*time.Minute), now.Add(-90*time.Second), now, grace, stale) {
		t.Fatal("a peer dark past the stale window must be flagged unreachable")
	}
}

func waitConnectivityReports(t *testing.T, fc *fakeClient, want int) []control.ConnectivityReport {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		reports := fc.connectivityReports()
		if len(reports) >= want {
			return reports
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fc.connectivityReports()
}

func TestCheckReachabilityReportsUnreachableEdge(t *testing.T) {
	pk := mustTestKey(0x61)
	ft := &fakeTun{ipcGet: "public_key=" + hex.EncodeToString(pk[:]) + "\nlast_handshake_time_sec=0\nrx_bytes=100\n"}
	table := routing.NewTable()
	table.Upsert(&routing.PeerRoute{
		PublicKey:   pk,
		VPN4:        netip.MustParseAddr("198.18.0.88"),
		DERPURL:     "https://relay.example.com/derp",
		DERPNodeKey: "nodekey:0123456789abcdef",
	})
	fc := &fakeClient{}
	now := time.Now()
	d := &daemon{
		table:      table,
		tunIf:      ft,
		cli:        fc,
		activeRoom: "lobby-l1-r1-voice",
		connCtx:    context.Background(),
		reach: map[wgtypes.Key]*peerReachState{
			pk: {
				firstSeen:    now.Add(-5 * time.Minute),
				lastProgress: now.Add(-2 * time.Minute),
				lastRx:       100,
				haveLastRx:   true,
			},
		},
	}

	d.checkReachability(context.Background())

	reports := waitConnectivityReports(t, fc, 1)
	if len(reports) != 1 {
		t.Fatalf("connectivity reports = %+v, want one unreachable report", reports)
	}
	if got := reports[0]; got.PeerPublicKey != pk.String() || got.ICEDirect || got.WGReachable || got.Transport != "" || got.Reason != "unreachable" {
		t.Fatalf("unexpected unreachable report: %+v", got)
	}
	if st := d.reach[pk]; st == nil || !st.reportedUnreachable {
		t.Fatalf("peer reach state should remain marked unreachable: %+v", st)
	}
}

func TestCheckReachabilityReportsDERPRecovery(t *testing.T) {
	pk := mustTestKey(0x62)
	now := time.Now()
	ft := &fakeTun{ipcGet: "public_key=" + hex.EncodeToString(pk[:]) + "\nlast_handshake_time_sec=" + strconv.FormatInt(now.Unix(), 10) + "\nrx_bytes=128\n"}
	table := routing.NewTable()
	table.Upsert(&routing.PeerRoute{
		PublicKey:   pk,
		VPN4:        netip.MustParseAddr("198.18.0.89"),
		DERPURL:     "https://relay.example.com/derp",
		DERPNodeKey: "nodekey:0123456789abcdef",
	})
	fc := &fakeClient{}
	d := &daemon{
		table:      table,
		tunIf:      ft,
		cli:        fc,
		activeRoom: "lobby-l1-r1-voice",
		connCtx:    context.Background(),
		reach: map[wgtypes.Key]*peerReachState{
			pk: {
				firstSeen:           now.Add(-5 * time.Minute),
				lastProgress:        now.Add(-2 * time.Minute),
				lastRx:              100,
				haveLastRx:          true,
				reportedUnreachable: true,
			},
		},
	}

	d.checkReachability(context.Background())

	reports := waitConnectivityReports(t, fc, 1)
	if len(reports) != 1 {
		t.Fatalf("connectivity reports = %+v, want one recovery report", reports)
	}
	if got := reports[0]; got.PeerPublicKey != pk.String() || got.ICEDirect || !got.WGReachable || got.Transport != "derp" || got.Reason != "derp-recovery" {
		t.Fatalf("unexpected recovery report: %+v", got)
	}
	if st := d.reach[pk]; st == nil || st.reportedUnreachable {
		t.Fatalf("peer reach state should clear unreachable marker: %+v", st)
	}
}

func TestDERPBaselineReportDoesNotClobberUnreachableEdge(t *testing.T) {
	pk := mustTestKey(0x63)
	fc := &fakeClient{}
	route := &routing.PeerRoute{
		PublicKey:   pk,
		VPN4:        netip.MustParseAddr("198.18.0.90"),
		DERPURL:     "https://relay.example.com/derp",
		DERPNodeKey: "nodekey:0123456789abcdef",
	}
	d := &daemon{
		cli:        fc,
		activeRoom: "lobby-l1-r1-voice",
		connCtx:    context.Background(),
		reach: map[wgtypes.Key]*peerReachState{
			pk: {reportedUnreachable: true},
		},
	}

	d.reportDERPReachabilityLocked([]*routing.PeerRoute{route}, "derp-baseline")

	if reports := waitConnectivityReports(t, fc, 1); len(reports) != 0 {
		t.Fatalf("DERP baseline report should be suppressed for unreachable peer, got %+v", reports)
	}
}

func TestICEDirectReachabilityReportRefreshesTopologyEdge(t *testing.T) {
	pk := mustTestKey(0x64)
	fc := &fakeClient{}
	route := &routing.PeerRoute{
		PublicKey: pk,
		VPN4:      netip.MustParseAddr("198.18.0.91"),
		ICEReady:  true,
	}
	d := &daemon{
		cli:        fc,
		activeRoom: "lobby-l1-r1-voice",
		connCtx:    context.Background(),
	}

	d.reportICEDirectReachabilityLocked([]*routing.PeerRoute{route})

	reports := waitConnectivityReports(t, fc, 1)
	if len(reports) != 1 {
		t.Fatalf("connectivity reports = %+v, want one ICE refresh report", reports)
	}
	if got := reports[0]; got.PeerPublicKey != pk.String() || !got.ICEDirect || !got.WGReachable || got.Transport != "ice" || got.Reason != "" {
		t.Fatalf("unexpected ICE refresh report: %+v", got)
	}
}
