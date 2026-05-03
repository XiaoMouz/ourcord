package derp

import (
	"encoding/base64"
	"fmt"
	"net/netip"
	"strings"

	"golang.zx2c4.com/wireguard/conn"
)

const endpointPrefix = "derp://"

// EndpointString encodes a DERP relay URL and peer node key into a string that
// can flow through WireGuard UAPI's endpoint= field.
func EndpointString(relayURL, nodeKey string) (string, error) {
	if relayURL == "" {
		return "", fmt.Errorf("derp relay URL required")
	}
	nodeHex, ok := strings.CutPrefix(nodeKey, "nodekey:")
	if !ok || nodeHex == "" {
		return "", fmt.Errorf("derp node key must have nodekey: prefix")
	}
	encURL := base64.RawURLEncoding.EncodeToString([]byte(relayURL))
	return endpointPrefix + encURL + "/" + nodeHex, nil
}

func ParseEndpointString(s string) (*Endpoint, error) {
	rest, ok := strings.CutPrefix(s, endpointPrefix)
	if !ok {
		return nil, fmt.Errorf("not a derp endpoint")
	}
	encURL, nodeHex, ok := strings.Cut(rest, "/")
	if !ok || encURL == "" || nodeHex == "" {
		return nil, fmt.Errorf("malformed derp endpoint")
	}
	rawURL, err := base64.RawURLEncoding.DecodeString(encURL)
	if err != nil {
		return nil, fmt.Errorf("decode derp relay URL: %w", err)
	}
	nodeKey := "nodekey:" + nodeHex
	return &Endpoint{
		RelayURL: string(rawURL),
		NodeKey:  nodeKey,
		raw:      s,
	}, nil
}

type Endpoint struct {
	RelayURL string
	NodeKey  string
	raw      string
}

var _ conn.Endpoint = (*Endpoint)(nil)

func (e *Endpoint) ClearSrc() {}
func (e *Endpoint) SrcToString() string {
	return ""
}
func (e *Endpoint) DstToString() string {
	if e.raw != "" {
		return e.raw
	}
	s, _ := EndpointString(e.RelayURL, e.NodeKey)
	return s
}
func (e *Endpoint) DstToBytes() []byte { return []byte(e.DstToString()) }
func (e *Endpoint) DstIP() netip.Addr  { return netip.Addr{} }
func (e *Endpoint) SrcIP() netip.Addr  { return netip.Addr{} }
