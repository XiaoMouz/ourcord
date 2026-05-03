package ice

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/netip"
	"strings"
)

const endpointScheme = "ice://"

// EndpointString encodes a WireGuard public key into a bind endpoint that
// routes packets through an already-established ICE Conn for that peer.
func EndpointString(peerPublicKey string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(peerPublicKey)
	if err != nil {
		return "", fmt.Errorf("decode peer public key: %w", err)
	}
	return endpointScheme + base64.RawURLEncoding.EncodeToString(raw), nil
}

func ParseEndpointString(s string) (*Endpoint, error) {
	if !strings.HasPrefix(s, endpointScheme) {
		return nil, fmt.Errorf("not an ice endpoint")
	}
	enc := strings.TrimPrefix(s, endpointScheme)
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		return nil, fmt.Errorf("decode ice endpoint: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("ice endpoint public key has %d bytes, want 32", len(raw))
	}
	return &Endpoint{PeerPublicKey: base64.StdEncoding.EncodeToString(raw)}, nil
}

type Endpoint struct {
	PeerPublicKey string
}

var _ net.Addr = (*Endpoint)(nil)

func (e *Endpoint) Network() string { return "ice" }
func (e *Endpoint) String() string {
	if e == nil {
		return ""
	}
	s, err := EndpointString(e.PeerPublicKey)
	if err != nil {
		return ""
	}
	return s
}

func (e *Endpoint) ClearSrc() {}
func (e *Endpoint) SrcToString() string {
	return ""
}
func (e *Endpoint) DstToString() string {
	return e.String()
}
func (e *Endpoint) DstToBytes() []byte {
	return []byte(e.String())
}
func (e *Endpoint) DstIP() netip.Addr { return netip.Addr{} }
func (e *Endpoint) SrcIP() netip.Addr { return netip.Addr{} }
