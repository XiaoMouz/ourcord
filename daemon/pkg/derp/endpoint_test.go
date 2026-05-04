package derp

import (
	"testing"

	"tailscale.com/types/key"
)

func TestEndpointStringRoundTrip(t *testing.T) {
	raw, err := EndpointString("http://127.0.0.1:3340", "nodekey:0123456789abcdef")
	if err != nil {
		t.Fatalf("EndpointString: %v", err)
	}
	ep, err := ParseEndpointString(raw)
	if err != nil {
		t.Fatalf("ParseEndpointString: %v", err)
	}
	if ep.RelayURL != "http://127.0.0.1:3340" {
		t.Fatalf("relay URL = %q", ep.RelayURL)
	}
	if ep.NodeKey != "nodekey:0123456789abcdef" {
		t.Fatalf("node key = %q", ep.NodeKey)
	}
}

func TestManagerSuppressionMap(t *testing.T) {
	m := NewManager(newTestNodeKey(t), nil)
	key := "nodekey:0123456789abcdef"
	m.SetSuppressed(key, true)
	if !m.suppressed[key] {
		t.Fatal("expected key suppressed")
	}
	m.SetSuppressed(key, false)
	if m.suppressed[key] {
		t.Fatal("expected key unsuppressed")
	}
}

func newTestNodeKey(t *testing.T) key.NodePrivate {
	t.Helper()
	return key.NewNode()
}
