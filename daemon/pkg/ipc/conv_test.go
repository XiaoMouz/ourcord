package ipc

import (
	"reflect"
	"testing"
)

func TestStatusRoundTrip(t *testing.T) {
	in := DaemonStatus{
		Running: true, VPNActive: true, IP4: "198.18.0.2", IP6: "fd00::2",
		NetworkID: "lobby-x-voice", RoomID: "lobby-x-voice", PeerCount: 3,
		RelayUsed: true, RelayURL: "http://r/derp", PathSummary: "next-hop",
		PathFlapsTotal: 7,
		Transport: TransportStats{
			MTU: 1280, ICESentPackets: 1, ICERecvPackets: 2, ICERecvDrops: 3,
			ICESendErrors: 4, ICERecvErrors: 5, ICEProbeSent: 6, ICEProbeAckSent: 7,
			ICEProbeAckReceived: 8, ICEProbeTimeouts: 9, ICEProbeInvalid: 10,
			ICEMaxPacketBytes: 11, DERPSentPackets: 12, DERPRecvPackets: 13,
			DERPRecvDrops: 14, DERPSuppressedPackets: 15, DERPSendErrors: 16,
			DERPRecvErrors: 17, DERPMaxPacketBytes: 18,
		},
	}
	got := StatusFromProto(StatusToProto(in))
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("status round-trip mismatch:\n in=%+v\nout=%+v", in, got)
	}
}

func TestPeerRoundTrip(t *testing.T) {
	in := ConnectedPeer{
		PublicKey: "pk", UserID: "u1", DisplayName: "Alice", Name: "peer-b", IP4: "198.18.0.3", IP6: "fd00::3",
		Direct: true, Path: "direct", Endpoint: "ice", CandidateEndpoint: "1.2.3.4:5",
		RelayURL: "http://r/derp", NextHop: "pk2", LatencyMs: 1.5, LastSeenSecs: 42,
		LastError: "boom", PathTransitions: 4, PathDwellSecs: 9, Flapping: true,
	}
	got := PeerFromProto(PeerToProto(in))
	if !reflect.DeepEqual(in, got) {
		t.Fatalf("peer round-trip mismatch:\n in=%+v\nout=%+v", in, got)
	}
}

func TestPathMappingCoversAllLabels(t *testing.T) {
	// Every label routePath/summarizeRoutes can emit must survive the enum trip;
	// unknown labels collapse to "" (PATH_UNSPECIFIED) by contract.
	for _, label := range []string{"inactive", "no-peers", "waiting", "direct", "derp", "next-hop", "degraded", "unresolved"} {
		if got := pathFromProto(pathToProto(label)); got != label {
			t.Fatalf("path %q round-tripped to %q", label, got)
		}
	}
	if got := pathFromProto(pathToProto("something-new")); got != "" {
		t.Fatalf("unknown path should map to empty, got %q", got)
	}
}
