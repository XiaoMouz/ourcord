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
	if !relayUsed || relayURL != "http://relay.example/derp" {
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

func TestPeerICEValidatedRequiresFreshHandshakeAndRXGrowth(t *testing.T) {
	started := time.Unix(100, 0)
	baseline := wgPeerStats{Found: true, LastHandshake: started, RXBytes: 10}
	if peerICEValidated(wgPeerStats{Found: true, LastHandshake: started.Add(time.Second), RXBytes: 10}, baseline, started) {
		t.Fatal("must not validate without RX growth")
	}
	if !peerICEValidated(wgPeerStats{Found: true, LastHandshake: started.Add(time.Second), RXBytes: 11}, baseline, started) {
		t.Fatal("expected fresh handshake plus RX growth to validate")
	}
	if peerICEValidated(wgPeerStats{Found: true, LastHandshake: started.Add(-2 * time.Second), RXBytes: 11}, baseline, started) {
		t.Fatal("stale handshake must not validate")
	}
}
