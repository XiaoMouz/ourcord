package logging

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestWriterFormatsAndRedacts(t *testing.T) {
	var out bytes.Buffer
	w, err := NewWriter(&out, "daemon", "json", Info)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("peer ICE validation failed; fallback state applied: dt_abcdefghijklmnopqrstuvwxyz0123456789\n")); err != nil {
		t.Fatal(err)
	}
	var line map[string]any
	if err := json.Unmarshal(out.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if line["event"] != "network.path.derp_fallback" || line["level"] != "error" {
		t.Fatalf("unexpected log line: %#v", line)
	}
	if got := line["msg"].(string); got == "" || bytes.Contains([]byte(got), []byte("dt_")) {
		t.Fatalf("credential was not redacted: %q", got)
	}
}

func TestWriterFiltersBelowMinimumLevel(t *testing.T) {
	var out bytes.Buffer
	w, err := NewWriter(&out, "daemon", "json", Error)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("Daemon ready\n"))
	if out.Len() != 0 {
		t.Fatalf("info line should be filtered: %s", out.String())
	}
}
