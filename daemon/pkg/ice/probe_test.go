package ice

import (
	"testing"
	"time"
)

func TestProbeConfirmedRequiresSustainedReliablePath(t *testing.T) {
	cases := []struct {
		name    string
		acks    int
		sent    int
		elapsed time.Duration
		want    bool
	}{
		{"too few acks", iceProbeConfirmMinAcks - 1, iceProbeConfirmMinAcks - 1, iceProbeConfirmWindow, false},
		{"window too short", iceProbeConfirmMinAcks, iceProbeConfirmMinAcks, iceProbeConfirmWindow - time.Millisecond, false},
		{"too lossy", iceProbeConfirmMinAcks, iceProbeConfirmMinAcks * 3, iceProbeConfirmWindow, false},
		{"no probes sent", iceProbeConfirmMinAcks, 0, iceProbeConfirmWindow, false},
		{"confirms with margin", iceProbeConfirmMinAcks, iceProbeConfirmMinAcks + 2, iceProbeConfirmWindow, true},
		{"confirms clean path", 12, 12, iceProbeConfirmWindow, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := probeConfirmed(c.acks, c.sent, c.elapsed); got != c.want {
				t.Fatalf("probeConfirmed(%d,%d,%v) = %v, want %v", c.acks, c.sent, c.elapsed, got, c.want)
			}
		})
	}
}

func TestIsVPNInterfaceExcludesOverlayKeepsUnderlay(t *testing.T) {
	for _, name := range []string{"utun", "utun8", "ourcord0"} {
		if !isVPNInterface(name) {
			t.Fatalf("%q should be treated as a VPN/overlay interface", name)
		}
	}
	for _, name := range []string{"eth0", "en0", "wlan0", "lo"} {
		if isVPNInterface(name) {
			t.Fatalf("%q is an underlay interface and must be kept for ICE", name)
		}
	}
}

func TestLivenessLostTolerance(t *testing.T) {
	if livenessLost(iceProbeLivenessTimeout) {
		t.Fatal("a path within the keepalive tolerance must stay alive")
	}
	if !livenessLost(iceProbeLivenessTimeout + time.Millisecond) {
		t.Fatal("a path silent past the tolerance must be declared dead")
	}
}
