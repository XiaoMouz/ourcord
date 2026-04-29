package wg

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestGenerateKeyPair(t *testing.T) {
	kp, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	if kp.Private == kp.Public {
		t.Errorf("private == public, that should never happen")
	}
	// Public key derivable from private
	if kp.Public != kp.Private.PublicKey() {
		t.Errorf("public key doesn't match private.PublicKey()")
	}
}

func TestPublicKeyBase64RoundTrip(t *testing.T) {
	kp, err := GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	b64 := kp.PublicKeyBase64()
	decoded, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded) != 32 {
		t.Errorf("expected 32 bytes, got %d", len(decoded))
	}
	for i, b := range decoded {
		if b != kp.Public[i] {
			t.Errorf("byte %d mismatch", i)
			break
		}
	}
}

func TestPeerFromConfig_Valid(t *testing.T) {
	kp, _ := GenerateKeyPair()
	peer, err := PeerFromConfig(kp.PublicKeyBase64(), []string{"100.64.0.5/32", "fd7a::5/128"})
	if err != nil {
		t.Fatalf("PeerFromConfig: %v", err)
	}
	if peer.PublicKey != kp.Public {
		t.Errorf("public key mismatch")
	}
	if len(peer.AllowedIPs) != 2 {
		t.Fatalf("want 2 allowed prefixes, got %d", len(peer.AllowedIPs))
	}
}

func TestPeerFromConfig_InvalidBase64(t *testing.T) {
	_, err := PeerFromConfig("not-base64!!", []string{"100.64.0.5/32"})
	if err == nil {
		t.Fatal("expected error for invalid base64")
	}
	if !strings.Contains(err.Error(), "decode public key") {
		t.Errorf("expected decode error, got %v", err)
	}
}

func TestPeerFromConfig_InvalidCIDR(t *testing.T) {
	kp, _ := GenerateKeyPair()
	_, err := PeerFromConfig(kp.PublicKeyBase64(), []string{"not-a-cidr"})
	if err == nil {
		t.Fatal("expected error for invalid CIDR")
	}
}

func TestGeneratePSK(t *testing.T) {
	a, err := GeneratePSK()
	if err != nil {
		t.Fatalf("GeneratePSK: %v", err)
	}
	b, _ := GeneratePSK()
	if a == b {
		t.Errorf("two PSKs identical (cosmically unlikely)")
	}
}
