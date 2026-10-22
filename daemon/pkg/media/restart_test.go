package media

import (
	"net/netip"
	"testing"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func restartPackets(t *testing.T) (wgtypes.Key, wgtypes.Key, []*parsedPacket) {
	t.Helper()
	fab := newFabric()
	sender, receiver := mustKey(t), mustKey(t)
	senderAddr, receiverAddr := netip.MustParseAddr("198.19.0.10"), netip.MustParseAddr("198.19.0.11")
	receive := fab.endpoint(receiverAddr)
	var packets []*parsedPacket
	stateDir := t.TempDir()
	for i := 0; i < 2; i++ {
		counters, err := ReserveCounters(stateDir, sender.PublicKey())
		if err != nil {
			t.Fatal(err)
		}
		e, err := Start(Config{
			Counters: counters,
			SelfKey:  sender, VPN4: senderAddr, Conn: fab.endpoint(senderAddr), CaptureSource: idleCapture(),
		})
		if err != nil {
			t.Fatal(err)
		}
		e.UpdatePeers([]PeerInfo{{PublicKey: receiver.PublicKey(), VPN4: receiverAddr}})
		e.broadcast(make([]int16, FrameSamples))
		e.Stop()
		if len(receive.in) != 1 {
			t.Fatalf("expected one real encrypted packet, got %d", len(receive.in))
		}
		packet, err := parsePacket((<-receive.in).data)
		if err != nil {
			t.Fatal(err)
		}
		packets = append(packets, packet)
	}
	return sender, receiver, packets
}

func TestRestartDoesNotReuseMediaNonce(t *testing.T) {
	_, _, packets := restartPackets(t)
	if packets[0].header.SSRC == packets[1].header.SSRC && packets[0].counter == packets[1].counter {
		t.Fatalf("engine restart reused the same pair-key nonce: SSRC=%d counter=%d", packets[0].header.SSRC, packets[0].counter)
	}
}

func TestExistingReceiverAcceptsRestartedSender(t *testing.T) {
	sender, receiver, packets := restartPackets(t)
	key, err := pairKey(receiver, sender.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	open, err := newOpener(key, ssrcFor(sender.PublicKey()))
	if err != nil {
		t.Fatal(err)
	}
	for i, packet := range packets {
		if _, err := open.open(packet.ciphertext, packet.aad, packet.counter); err != nil {
			t.Fatalf("receiver rejected packet from engine %d: %v", i, err)
		}
	}
}

func TestRestartResetsReceiverJitterOnlyAfterAuthentication(t *testing.T) {
	senderKey, receiverKey := mustKey(t), mustKey(t)
	senderAddr, receiverAddr := netip.MustParseAddr("198.19.0.20"), netip.MustParseAddr("198.19.0.21")
	fab := newFabric()
	wire := fab.endpoint(receiverAddr)
	receiver, err := Start(Config{
		SelfKey: receiverKey, Counters: testCounters(receiverKey), VPN4: receiverAddr,
		Conn: newFabric().endpoint(receiverAddr), CaptureSource: idleCapture(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Stop()
	receiver.UpdatePeers([]PeerInfo{{PublicKey: senderKey.PublicKey(), VPN4: senderAddr}})
	dir := t.TempDir()
	var oldPacket []byte
	for generation := 0; generation < 2; generation++ {
		counters, err := ReserveCounters(dir, senderKey.PublicKey())
		if err != nil {
			t.Fatal(err)
		}
		sender, err := Start(Config{
			SelfKey: senderKey, Counters: counters, VPN4: senderAddr,
			Conn: fab.endpoint(senderAddr), CaptureSource: idleCapture(),
		})
		if err != nil {
			t.Fatal(err)
		}
		sender.UpdatePeers([]PeerInfo{{PublicKey: receiverKey.PublicKey(), VPN4: receiverAddr}})
		for i := 0; i < 8; i++ {
			sender.broadcast(make([]int16, FrameSamples))
			packet := (<-wire.in).data
			if generation == 0 {
				oldPacket = packet
			}
			if generation == 1 && i == 0 {
				tampered := append([]byte(nil), packet...)
				tampered[len(tampered)-1] ^= 1
				before := receiver.peers[senderKey.PublicKey()].jitter
				receiver.handleDatagram(tampered, senderAddr)
				if receiver.peers[senderKey.PublicKey()].jitter != before {
					t.Fatal("unauthenticated packet reset jitter")
				}
			}
			receiver.handleDatagram(packet, senderAddr)
		}
		sender.Stop()
		st := receiver.peers[senderKey.PublicKey()]
		if st.jitter.received != 6 || st.jitter.lost != 0 {
			t.Fatalf("generation %d playback failed: received=%d lost=%d", generation, st.jitter.received, st.jitter.lost)
		}
	}
	st := receiver.peers[senderKey.PublicKey()]
	before := st.rxPackets
	receiver.handleDatagram(oldPacket, senderAddr)
	if st.rxPackets != before {
		t.Fatal("old-session replay accepted after restart")
	}
}

func TestPeerRemovalDoesNotResetSenderNonce(t *testing.T) {
	fab := newFabric()
	key, peer := mustKey(t), mustKey(t)
	senderAddr, peerAddr := netip.MustParseAddr("198.19.0.30"), netip.MustParseAddr("198.19.0.31")
	wire := fab.endpoint(peerAddr)
	e, err := Start(Config{SelfKey: key, Counters: testCounters(key), VPN4: senderAddr, Conn: fab.endpoint(senderAddr), CaptureSource: idleCapture()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Stop()
	var previous uint64
	for i := 0; i < 2; i++ {
		e.UpdatePeers([]PeerInfo{{PublicKey: peer.PublicKey(), VPN4: peerAddr}})
		e.broadcast(make([]int16, FrameSamples))
		pkt, err := parsePacket((<-wire.in).data)
		if err != nil {
			t.Fatal(err)
		}
		if i > 0 && pkt.counter <= previous {
			t.Fatal("recreated peer reused/reset its nonce counter")
		}
		previous = pkt.counter
		e.UpdatePeers(nil)
	}
}

func TestOppositeDirectionsCannotShareNonceWithCollidingSSRCs(t *testing.T) {
	a, b := mustKey(t), mustKey(t)
	emit := func(self, peer wgtypes.Key) *parsedPacket {
		fab := newFabric()
		src, dst := netip.MustParseAddr("198.19.0.40"), netip.MustParseAddr("198.19.0.41")
		wire := fab.endpoint(dst)
		e, err := Start(Config{SelfKey: self, Counters: testCounters(self), VPN4: src, Conn: fab.endpoint(src), CaptureSource: idleCapture()})
		if err != nil {
			t.Fatal(err)
		}
		defer e.Stop()
		e.ssrc = 7
		e.UpdatePeers([]PeerInfo{{PublicKey: peer.PublicKey(), VPN4: dst}})
		e.broadcast(make([]int16, FrameSamples))
		pkt, err := parsePacket((<-wire.in).data)
		if err != nil {
			t.Fatal(err)
		}
		return pkt
	}
	first, second := emit(a, b.PublicKey()), emit(b, a.PublicKey())
	if first.header.SSRC != second.header.SSRC || first.counter^second.counter != 1<<63 {
		t.Fatal("opposite directions did not partition the shared-key nonce space")
	}
}

func TestExhaustedNonceRangeSendsNoPacket(t *testing.T) {
	key := mustKey(t)
	fab := newFabric()
	src, dst := netip.MustParseAddr("198.19.0.50"), netip.MustParseAddr("198.19.0.51")
	wire := fab.endpoint(dst)
	counters := testCounters(key)
	counters.next = counters.end
	e, err := Start(Config{SelfKey: key, Counters: counters, VPN4: src, Conn: fab.endpoint(src), CaptureSource: idleCapture()})
	if err != nil {
		t.Fatal(err)
	}
	defer e.Stop()
	e.UpdatePeers([]PeerInfo{{PublicKey: mustKey(t).PublicKey(), VPN4: dst}})
	for i := 0; i < 2; i++ {
		e.broadcast(make([]int16, FrameSamples))
	}
	if len(wire.in) != 0 {
		t.Fatal("exhausted reservation encrypted an unreserved nonce")
	}
	if e, err := Start(Config{SelfKey: key, Counters: testCounters(mustKey(t))}); err == nil || e != nil {
		t.Fatal("engine used another identity's nonce reservation")
	}
}
