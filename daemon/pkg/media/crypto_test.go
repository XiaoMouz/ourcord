package media

import (
	"bytes"
	"crypto/rand"
	"testing"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func mustKey(t *testing.T) wgtypes.Key {
	t.Helper()
	k, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestPairKeyIsSymmetric(t *testing.T) {
	a, b := mustKey(t), mustKey(t)
	ka, err := pairKey(a, b.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	kb, err := pairKey(b, a.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ka, kb) {
		t.Fatal("pairwise key must be identical on both ends")
	}
	// A third party's key derives a different secret.
	c := mustKey(t)
	kc, _ := pairKey(c, a.PublicKey())
	if bytes.Equal(ka, kc) {
		t.Fatal("unrelated peer must not derive the same key")
	}
}

func TestSealOpenRoundTrip(t *testing.T) {
	a, b := mustKey(t), mustKey(t)
	key, _ := pairKey(a, b.PublicKey())
	sndSSRC := ssrcFor(a.PublicKey())
	s, _ := newSealer(key, sndSSRC)
	o, _ := newOpener(key, sndSSRC)

	payload := []byte("twenty ms of audio")
	aad := []byte("rtp-header")
	ct, counter := s.seal(payload, aad)
	got, err := o.open(ct, aad, counter)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("round-trip failed: %v got=%q", err, got)
	}

	// Tampered AAD (a forged RTP header) is rejected.
	if _, err := o.open(ct, []byte("rtp-forged"), counter); err == nil {
		t.Fatal("tampered AAD must fail authentication")
	}
	// Wrong key cannot open.
	wrong := make([]byte, 32)
	rand.Read(wrong)
	ow, _ := newOpener(wrong, sndSSRC)
	if _, err := ow.open(ct, aad, counter); err == nil {
		t.Fatal("wrong key must fail to open")
	}
}

func TestReplayWindow(t *testing.T) {
	a, b := mustKey(t), mustKey(t)
	key, _ := pairKey(a, b.PublicKey())
	ssrc := ssrcFor(a.PublicKey())
	s, _ := newSealer(key, ssrc)
	o, _ := newOpener(key, ssrc)

	seal := func() ([]byte, uint64) { return s.seal([]byte("frame"), []byte("h")) }

	ct0, c0 := seal()
	ct1, c1 := seal()
	ct2, c2 := seal()

	// In-order accept.
	if _, err := o.open(ct0, []byte("h"), c0); err != nil {
		t.Fatalf("c0: %v", err)
	}
	// Replay of an accepted counter is rejected.
	if _, err := o.open(ct0, []byte("h"), c0); err == nil {
		t.Fatal("replay must be rejected")
	}
	// Out-of-order-but-fresh accepted, then its replay rejected.
	if _, err := o.open(ct2, []byte("h"), c2); err != nil {
		t.Fatalf("c2: %v", err)
	}
	if _, err := o.open(ct1, []byte("h"), c1); err != nil {
		t.Fatalf("c1 (reordered, fresh): %v", err)
	}
	if _, err := o.open(ct1, []byte("h"), c1); err == nil {
		t.Fatal("replay of reordered frame must be rejected")
	}
}

func TestSSRCStableAndDistinct(t *testing.T) {
	a, b := mustKey(t), mustKey(t)
	if ssrcFor(a.PublicKey()) != ssrcFor(a.PublicKey()) {
		t.Fatal("ssrc must be stable for a key")
	}
	if ssrcFor(a.PublicKey()) == ssrcFor(b.PublicKey()) {
		t.Fatal("distinct keys should (almost always) yield distinct ssrc")
	}
}
