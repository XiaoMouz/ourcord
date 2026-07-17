package main

import (
	"net/netip"
	"strings"
	"testing"
)

func TestVPNPoolFakeIPMessage(t *testing.T) {
	tests := []struct {
		name     string
		addrs    []netip.Addr
		wantHint bool
	}{
		{name: "clash default fake-ip", addrs: []netip.Addr{netip.MustParseAddr("198.18.0.7")}, wantHint: true},
		{name: "upper pool half", addrs: []netip.Addr{netip.MustParseAddr("198.19.4.2")}, wantHint: true},
		{name: "real cloudflare edge", addrs: []netip.Addr{netip.MustParseAddr("104.21.81.199")}, wantHint: false},
		{name: "adjacent but outside pool", addrs: []netip.Addr{netip.MustParseAddr("198.20.0.1")}, wantHint: false},
		{name: "mapped v4-in-v6", addrs: []netip.Addr{netip.MustParseAddr("::ffff:198.18.0.7")}, wantHint: true},
		{name: "no answers", addrs: nil, wantHint: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := vpnPoolFakeIPMessage("control.example", tt.addrs)
			if (got != "") != tt.wantHint {
				t.Fatalf("vpnPoolFakeIPMessage() = %q, wantHint %v", got, tt.wantHint)
			}
			if tt.wantHint && !strings.Contains(got, "fake-ip") {
				t.Fatalf("hint %q should mention fake-ip", got)
			}
		})
	}
}

func TestControlFakeIPHintLiteralHost(t *testing.T) {
	// Literal in-pool control URLs (e.g. a mis-set --control-url behind a
	// fake-ip proxy) are classified without any DNS lookup.
	if got := controlFakeIPHint("https://198.18.0.9:8443"); got == "" {
		t.Fatal("expected hint for in-pool literal control host")
	}
	if got := controlFakeIPHint("https://203.0.113.10"); got != "" {
		t.Fatalf("unexpected hint for out-of-pool literal host: %q", got)
	}
	if got := controlFakeIPHint("::not a url::"); got != "" {
		t.Fatalf("unexpected hint for unparseable URL: %q", got)
	}
}

func TestScanForOverlapMultipleNeedles(t *testing.T) {
	routes := strings.Join([]string{
		"Destination        Gateway",
		"default            192.168.1.1",
		"198.18.0.0/16      utun9", // Clash fake-ip route
		"198.19.0.2/32      utun4", // our peer route
		"10.0.0.0/8         en0",
	}, "\n")
	hits := scanForOverlap(routes, "198.18.", "198.19.")
	if len(hits) != 2 {
		t.Fatalf("scanForOverlap() = %v, want 2 hits", hits)
	}
}
