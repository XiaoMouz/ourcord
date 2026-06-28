package main

import (
	"net/netip"
	"testing"

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

func TestConnectedPeersNextHopStatus(t *testing.T) {
	hop := testKey(t, 0x18)
	routes := []*routing.PeerRoute{{
		PublicKey: testKey(t, 0x19),
		VPN4:      netip.MustParseAddr("198.18.0.8"),
		NextHop:   &hop,
	}}

	relayUsed, relayURL, summary := summarizeRoutes(true, routes)
	if summary != "next-hop" || relayUsed || relayURL != "" {
		t.Fatalf("summary/relay = %q/%v/%q", summary, relayUsed, relayURL)
	}

	peers := connectedPeers(routes)
	if len(peers) != 1 {
		t.Fatalf("peers len = %d", len(peers))
	}
	if peers[0].Path != "next-hop" || peers[0].Direct {
		t.Fatalf("peer path/direct = %q/%v", peers[0].Path, peers[0].Direct)
	}
	if peers[0].NextHop != hop.String() {
		t.Fatalf("next_hop = %q, want %q", peers[0].NextHop, hop.String())
	}
	if peers[0].LastError != "" {
		t.Fatalf("last_error = %q", peers[0].LastError)
	}
}

func mustAddrPortForStatus(t *testing.T, s string) *netip.AddrPort {
	t.Helper()
	ap := netip.MustParseAddrPort(s)
	return &ap
}
