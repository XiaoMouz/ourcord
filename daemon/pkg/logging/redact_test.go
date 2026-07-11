package logging

import (
	"strings"
	"testing"
)

func TestRedact(t *testing.T) {
	cases := []struct {
		name       string
		in         string
		mustHide   string // substring that must NOT survive
		mustKeep   string // substring that must survive (e.g. public keys)
		wantMarker string // redaction marker expected in the output
	}{
		{
			name:       "device token",
			in:         "exchanged dt_abcdefghijklmnopqrstuvwxyz0123456789 for jwt",
			mustHide:   "dt_abcdefghijklmnopqrstuvwxyz0123456789",
			wantMarker: "[REDACTED_DEVICE_TOKEN]",
		},
		{
			name:       "two-part ourcord jwt (bare)",
			in:         "auth token eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlX2Jsb2I expired",
			mustHide:   "eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlX2Jsb2I",
			wantMarker: "[REDACTED_JWT]",
		},
		{
			name:       "three-part standard jwt",
			in:         "Authorization header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnYmxvYg present",
			mustHide:   "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnYmxvYg",
			wantMarker: "[REDACTED_JWT]",
		},
		{
			// A non-JWT opaque token in a URL query must be caught by the
			// token= rule (the JWT rule wouldn't match it).
			name:       "opaque websocket token in url",
			in:         "GET /api/signal/room1?token=opaque0secret1value2&pk=abc123 101",
			mustHide:   "opaque0secret1value2",
			mustKeep:   "pk=abc123",
			wantMarker: "token=[REDACTED]",
		},
		{
			name:       "bearer header",
			in:         "sent Bearer sometokenvalue1234 upstream",
			mustHide:   "Bearer sometokenvalue1234",
			wantMarker: "Bearer [REDACTED]",
		},
		{
			name:     "public key and vpn ip are preserved",
			in:       "registered peer YcUBum7E70U1TOFzlvuLJpUcTCcf39nEGfKaiaYsXDs= at 198.18.0.3",
			mustKeep: "YcUBum7E70U1TOFzlvuLJpUcTCcf39nEGfKaiaYsXDs=",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Redact(c.in)
			if c.mustHide != "" && strings.Contains(got, c.mustHide) {
				t.Fatalf("secret survived redaction: %q -> %q", c.in, got)
			}
			if c.mustKeep != "" && !strings.Contains(got, c.mustKeep) {
				t.Fatalf("non-secret was scrubbed: %q -> %q", c.in, got)
			}
			if c.wantMarker != "" && !strings.Contains(got, c.wantMarker) {
				t.Fatalf("missing redaction marker %q in %q", c.wantMarker, got)
			}
		})
	}
}
