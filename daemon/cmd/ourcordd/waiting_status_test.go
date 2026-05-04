package main

import (
	"encoding/hex"
	"fmt"
	"net/netip"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/routing"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func testKey(t *testing.T, b byte) wgtypes.Key {
	t.Helper()
	var k wgtypes.Key
	for i := range k {
		k[i] = b
	}
	return k
}

func TestSummarizeRoutesWaiting(t *testing.T) {
	relayUsed, relayURL, summary := summarizeRoutes(true, []*routing.PeerRoute{{
		PublicKey:   testKey(t, 0x11),
		VPN4:        netip.MustParseAddr("198.18.0.3"),
		ICEPending:  true,
		DERPURL:     "http://relay.example/derp",
		DERPNodeKey: "nodekey:abc",
	}})
	if summary != "waiting" {
		t.Fatalf("summary = %q, want waiting", summary)
	}
	if relayUsed || relayURL != "http://relay.example/derp" {
		t.Fatalf("relay fallback = (%v, %q)", relayUsed, relayURL)
	}
}

func TestConnectedPeersWaiting(t *testing.T) {
	peers := connectedPeers([]*routing.PeerRoute{{
		PublicKey:   testKey(t, 0x12),
		VPN4:        netip.MustParseAddr("198.18.0.4"),
		ICEPending:  true,
		DERPURL:     "http://relay.example/derp",
		DERPNodeKey: "nodekey:def",
		LastError:   "ice-validation-failed",
	}})
	if len(peers) != 1 {
		t.Fatalf("peers len = %d", len(peers))
	}
	if peers[0].Path != "waiting" || peers[0].Direct {
		t.Fatalf("peer path/direct = %q/%v", peers[0].Path, peers[0].Direct)
	}
	if peers[0].Endpoint != "ice" {
		t.Fatalf("endpoint = %q, want ice", peers[0].Endpoint)
	}
	if peers[0].LastError != "ice-validation-failed" {
		t.Fatalf("last_error = %q", peers[0].LastError)
	}
}

func TestConnectedPeersDirectCandidateWaiting(t *testing.T) {
	peers := connectedPeers([]*routing.PeerRoute{{
		PublicKey:  testKey(t, 0x15),
		VPN4:       netip.MustParseAddr("198.18.0.5"),
		DirectAddr: mustAddrPortForStatus(t, "203.0.113.5:51820"),
	}})
	if len(peers) != 1 {
		t.Fatalf("peers len = %d", len(peers))
	}
	if peers[0].Path != "waiting" || peers[0].Direct {
		t.Fatalf("peer path/direct = %q/%v", peers[0].Path, peers[0].Direct)
	}
	if peers[0].Endpoint != "" {
		t.Fatalf("endpoint = %q, want empty candidate-only endpoint", peers[0].Endpoint)
	}
	if peers[0].CandidateEndpoint != "203.0.113.5:51820" {
		t.Fatalf("candidate_endpoint = %q", peers[0].CandidateEndpoint)
	}
	if peers[0].LastError != "no-derp-route" {
		t.Fatalf("last_error = %q", peers[0].LastError)
	}
}

func TestConnectedPeersDERPBaselineIgnoresDirectCandidate(t *testing.T) {
	relayUsed, relayURL, summary := summarizeRoutes(true, []*routing.PeerRoute{{
		PublicKey:   testKey(t, 0x16),
		VPN4:        netip.MustParseAddr("198.18.0.6"),
		DirectAddr:  mustAddrPortForStatus(t, "203.0.113.6:51820"),
		DERPURL:     "http://relay.example/derp",
		DERPNodeKey: "nodekey:ghi",
	}})
	if summary != "derp" || !relayUsed || relayURL != "http://relay.example/derp" {
		t.Fatalf("summary/relay = %q/%v/%q", summary, relayUsed, relayURL)
	}

	peers := connectedPeers([]*routing.PeerRoute{{
		PublicKey:   testKey(t, 0x16),
		VPN4:        netip.MustParseAddr("198.18.0.6"),
		DirectAddr:  mustAddrPortForStatus(t, "203.0.113.6:51820"),
		DERPURL:     "http://relay.example/derp",
		DERPNodeKey: "nodekey:ghi",
	}})
	if peers[0].Path != "derp" || peers[0].Direct {
		t.Fatalf("peer path/direct = %q/%v", peers[0].Path, peers[0].Direct)
	}
	if peers[0].Endpoint != "" {
		t.Fatalf("endpoint = %q, want empty actual endpoint for DERP status", peers[0].Endpoint)
	}
	if peers[0].CandidateEndpoint != "203.0.113.6:51820" {
		t.Fatalf("candidate_endpoint = %q", peers[0].CandidateEndpoint)
	}
}

func TestConnectedPeersDERPFallbackDegraded(t *testing.T) {
	routes := []*routing.PeerRoute{{
		PublicKey:   testKey(t, 0x17),
		VPN4:        netip.MustParseAddr("198.18.0.7"),
		DERPURL:     "http://relay.example/derp",
		DERPNodeKey: "nodekey:jkl",
		LastError:   "direct-health-degraded",
	}}
	relayUsed, relayURL, summary := summarizeRoutes(true, routes)
	if summary != "degraded" || !relayUsed || relayURL != "http://relay.example/derp" {
		t.Fatalf("summary/relay = %q/%v/%q", summary, relayUsed, relayURL)
	}

	peers := connectedPeers(routes)
	if len(peers) != 1 {
		t.Fatalf("peers len = %d", len(peers))
	}
	if peers[0].Path != "degraded" || peers[0].Direct {
		t.Fatalf("peer path/direct = %q/%v", peers[0].Path, peers[0].Direct)
	}
	if peers[0].Endpoint != "" {
		t.Fatalf("endpoint = %q, want DERP fallback endpoint hidden from peer status", peers[0].Endpoint)
	}
	if peers[0].LastError != "direct-health-degraded" {
		t.Fatalf("last_error = %q", peers[0].LastError)
	}
}

func mustAddrPortForStatus(t *testing.T, s string) *netip.AddrPort {
	t.Helper()
	ap := netip.MustParseAddrPort(s)
	return &ap
}

func TestParsePeerStats(t *testing.T) {
	pk := testKey(t, 0x13)
	other := testKey(t, 0x14)
	raw := fmt.Sprintf(`private_key=ignored
public_key=%s
last_handshake_time_sec=10
last_handshake_time_nsec=20
tx_bytes=100
rx_bytes=200
public_key=%s
last_handshake_time_sec=30
last_handshake_time_nsec=40
tx_bytes=300
rx_bytes=400
`, hex.EncodeToString(other[:]), hex.EncodeToString(pk[:]))

	stats := parsePeerStats(raw, pk)
	if !stats.Found {
		t.Fatal("stats not found")
	}
	if !stats.LastHandshake.Equal(time.Unix(30, 40)) {
		t.Fatalf("handshake = %v", stats.LastHandshake)
	}
	if stats.TXBytes != 300 || stats.RXBytes != 400 {
		t.Fatalf("bytes tx/rx = %d/%d", stats.TXBytes, stats.RXBytes)
	}
}

func TestPeerICEValidatedRequiresRXGrowth(t *testing.T) {
	started := time.Unix(100, 0)
	baseline := wgPeerStats{Found: true, LastHandshake: started, RXBytes: 10, TXBytes: 20}
	if peerICEValidated(wgPeerStats{Found: true, LastHandshake: started.Add(time.Second), RXBytes: 10, TXBytes: 20}, baseline, started) {
		t.Fatal("must not validate without RX growth")
	}
	if peerICEValidated(wgPeerStats{Found: true, LastHandshake: started.Add(time.Second), RXBytes: 10, TXBytes: 21}, baseline, started) {
		t.Fatal("TX-only growth must not validate the direct data path")
	}
	if !peerICEValidated(wgPeerStats{Found: true, LastHandshake: started.Add(-2 * time.Second), RXBytes: 11, TXBytes: 20}, baseline, started) {
		t.Fatal("expected RX growth to validate even without a fresh handshake")
	}
}

func TestDirectHealthWindowDegradesOnRepeatedTXOnlySamples(t *testing.T) {
	prev := wgPeerStats{Found: true, RXBytes: 10, TXBytes: 10}
	stats := []wgPeerStats{
		{Found: true, RXBytes: 11, TXBytes: 11},
		{Found: true, RXBytes: 11, TXBytes: 12},
		{Found: true, RXBytes: 12, TXBytes: 13},
		{Found: true, RXBytes: 12, TXBytes: 14},
		{Found: true, RXBytes: 13, TXBytes: 15},
	}
	var window []bool
	for _, st := range stats {
		active, miss := directHealthSample(prev, st)
		if !active {
			t.Fatalf("sample should be active: prev=%+v stats=%+v", prev, st)
		}
		window = appendDirectHealthSample(window, miss)
		prev = st
	}
	if !directHealthDegraded(window) {
		t.Fatalf("expected degraded window, got %v", window)
	}
}

func TestDirectHealthWindowAllowsHealthyTraffic(t *testing.T) {
	prev := wgPeerStats{Found: true, RXBytes: 10, TXBytes: 10}
	var window []bool
	for i := 0; i < directHealthWindow; i++ {
		next := wgPeerStats{Found: true, RXBytes: prev.RXBytes + 1, TXBytes: prev.TXBytes + 1}
		active, miss := directHealthSample(prev, next)
		if !active || miss {
			t.Fatalf("sample active/miss = %v/%v", active, miss)
		}
		window = appendDirectHealthSample(window, miss)
		prev = next
	}
	if directHealthDegraded(window) {
		t.Fatalf("healthy traffic must not degrade, got %v", window)
	}
}
