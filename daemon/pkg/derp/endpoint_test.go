package derp

import "testing"

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
