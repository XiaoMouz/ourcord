// Package wg manages WireGuard keys, peers, and the userspace WireGuard engine.
package wg

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/netip"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// KeyPair holds a WireGuard private/public key pair.
type KeyPair struct {
	Private wgtypes.Key
	Public  wgtypes.Key
}

// GenerateKeyPair creates a new WireGuard key pair.
func GenerateKeyPair() (*KeyPair, error) {
	priv, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		return nil, fmt.Errorf("generate wg private key: %w", err)
	}
	return &KeyPair{
		Private: priv,
		Public:  priv.PublicKey(),
	}, nil
}

// PublicKeyBase64 returns the public key as a base64 string.
func (kp *KeyPair) PublicKeyBase64() string {
	return base64.StdEncoding.EncodeToString(kp.Public[:])
}

// Peer represents a remote WireGuard peer.
type Peer struct {
	PublicKey  wgtypes.Key
	AllowedIPs []netip.Prefix
	Endpoint   *netip.AddrPort // nil if not yet known (will use DERP)
	DERPURL    string          // DERP relay URL for this peer
}

// PeerFromConfig builds a Peer from control-plane-provided config.
func PeerFromConfig(pubKeyB64 string, allowedIPs []string) (*Peer, error) {
	decoded, err := base64.StdEncoding.DecodeString(pubKeyB64)
	if err != nil {
		return nil, fmt.Errorf("decode public key: %w", err)
	}
	var key wgtypes.Key
	copy(key[:], decoded)

	prefixes := make([]netip.Prefix, 0, len(allowedIPs))
	for _, cidr := range allowedIPs {
		prefix, err := netip.ParsePrefix(cidr)
		if err != nil {
			return nil, fmt.Errorf("parse allowed IP %q: %w", cidr, err)
		}
		prefixes = append(prefixes, prefix)
	}

	return &Peer{
		PublicKey:  key,
		AllowedIPs: prefixes,
	}, nil
}

// PreSharedKey generates a random 32-byte pre-shared key.
func GeneratePSK() (wgtypes.Key, error) {
	var psk wgtypes.Key
	_, err := rand.Read(psk[:])
	return psk, err
}
