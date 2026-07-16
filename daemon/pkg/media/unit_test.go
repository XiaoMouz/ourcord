package media

import "testing"

func TestPCMCodecRoundTrip(t *testing.T) {
	c := NewPCMCodec()
	enc, err := c.NewEncoder()
	if err != nil {
		t.Fatal(err)
	}
	dec, err := c.NewDecoder()
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]int16, FrameSamples)
	for i := range pcm {
		pcm[i] = int16(i*7 - 1000)
	}
	encoded, err := enc.Encode(pcm)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) != FrameSamples*2 {
		t.Fatalf("encoded len = %d, want %d", len(encoded), FrameSamples*2)
	}
	got, err := dec.Decode(encoded)
	if err != nil {
		t.Fatal(err)
	}
	for i := range got {
		if got[i] != pcm[i] {
			t.Fatalf("sample %d: got %d want %d", i, got[i], pcm[i])
		}
	}
	if _, err := enc.Encode(pcm[:10]); err == nil {
		t.Fatal("wrong frame size must error")
	}
}

func TestJitterBufferPrimesReordersConceals(t *testing.T) {
	j := newJitterBuffer(3)
	frame := func(v int16) []int16 { f := make([]int16, FrameSamples); f[0] = v; return f }

	// Not primed until depth frames buffered.
	j.push(100, frame(1))
	j.push(102, frame(3)) // 101 missing, arrives later
	if _, real := j.pop(); real {
		t.Fatal("must not emit before primed")
	}
	j.push(101, frame(2)) // reordered fill
	// Now 3 frames buffered → primed; pops in sequence order.
	for want := int16(1); want <= 3; want++ {
		f, real := j.pop()
		if !real || f[0] != want {
			t.Fatalf("pop %d: real=%v v=%d", want, real, f[0])
		}
	}
	// Missing 103 → concealment (silence, not real).
	if f, real := j.pop(); real || f[0] != 0 {
		t.Fatalf("expected concealment, got real=%v v=%d", real, f[0])
	}
	if j.lost != 1 || j.received != 3 {
		t.Fatalf("counters: received=%d lost=%d", j.received, j.lost)
	}
	if lp := j.lossPercent(); lp < 24 || lp > 26 {
		t.Fatalf("loss%% = %.1f, want ~25", lp)
	}
}

func TestPacketFramingRoundTrip(t *testing.T) {
	_, aad, err := marshalHeader(7, 960, 0xdeadbeef)
	if err != nil {
		t.Fatal(err)
	}
	datagram := assemble(aad, []byte("ciphertext-bytes"), 42)
	pkt, err := parsePacket(datagram)
	if err != nil {
		t.Fatal(err)
	}
	if pkt.header.SequenceNumber != 7 || pkt.header.SSRC != 0xdeadbeef ||
		pkt.counter != 42 || string(pkt.ciphertext) != "ciphertext-bytes" {
		t.Fatalf("parsed mismatch: %+v", pkt)
	}
	if !bytesEqual(pkt.aad, aad) {
		t.Fatal("aad must be the exact on-wire header bytes")
	}
	if _, err := parsePacket([]byte{0x80}); err == nil {
		t.Fatal("short packet must error")
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestSeqLess(t *testing.T) {
	if !seqLess(1, 2) || seqLess(2, 1) || seqLess(1, 1) {
		t.Fatal("basic ordering")
	}
	// Wrap: 65535 precedes 0.
	if !seqLess(65535, 0) || seqLess(0, 65535) {
		t.Fatal("wraparound ordering")
	}
}
