package logging

import (
	"bytes"
	"strings"
	"testing"
)

func TestWriterRedactsBearerToken(t *testing.T) {
	var out bytes.Buffer
	w, err := NewWriter(&out, "relay", "json", Info)
	if err != nil {
		t.Fatal(err)
	}
	_, err = w.Write([]byte("registered as relay; Authorization: Bearer eyJabc.def.ghi\n"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "eyJabc.def.ghi") || !strings.Contains(out.String(), "relay.registered") {
		t.Fatalf("unexpected output: %s", out.String())
	}
}
