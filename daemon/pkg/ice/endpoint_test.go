package ice

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestEndpointStringRoundTrip(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	key := base64.StdEncoding.EncodeToString(raw)
	s, err := EndpointString(key)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(s, "ice://") {
		t.Fatalf("endpoint = %q", s)
	}
	if strings.ContainsAny(strings.TrimPrefix(s, "ice://"), "/+=") {
		t.Fatalf("endpoint key must be URL-safe/no-padding: %q", s)
	}
	ep, err := ParseEndpointString(s)
	if err != nil {
		t.Fatal(err)
	}
	if ep.PeerPublicKey != key {
		t.Fatalf("peer key = %q, want %q", ep.PeerPublicKey, key)
	}
}
