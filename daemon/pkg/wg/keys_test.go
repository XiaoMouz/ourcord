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
	peer, err := PeerFromConfig(kp.PublicKeyBase64(), []string{"198.18.0.5/32", "fdab::5/128"})
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
	_, err := PeerFromConfig("not-base64!!", []string{"198.18.0.5/32"})
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

// M1: silent zero-pad / truncation must be rejected.
func TestPeerFromConfig_WrongLength(t *testing.T) {
	cases := []struct {
		name string
		raw  []byte
	}{
		{"too-short-31", make([]byte, 31)},
		{"too-long-33", make([]byte, 33)},
		{"empty", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b64 := base64.StdEncoding.EncodeToString(tc.raw)
			_, err := PeerFromConfig(b64, []string{"198.18.0.5/32"})
			if err == nil {
				t.Fatalf("expected error for %d-byte key, got nil", len(tc.raw))
			}
			if !strings.Contains(err.Error(), "32 bytes") {
				t.Errorf("expected length error, got %v", err)
			}
		})
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
