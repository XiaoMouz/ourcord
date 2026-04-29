package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateNodeKey_StableAcrossLoads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "node.key")

	k1, err := LoadOrCreateNodeKey(path)
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	k2, err := LoadOrCreateNodeKey(path)
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if k1.Public() != k2.Public() {
		t.Errorf("public key changed across reload")
	}

	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := st.Mode().Perm(); mode != 0o600 {
		t.Errorf("file mode = %o, want 0600", mode)
	}
}

func TestLoadOrCreateNodeKey_RejectsBadFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "node.key")
	if err := os.WriteFile(path, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateNodeKey(path); err == nil {
		t.Error("expected parse error")
	}
}

func TestRelayIDRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "relay.id")

	got, err := LoadRelayID(path)
	if err != nil {
		t.Fatalf("load missing: %v", err)
	}
	if got != "" {
		t.Errorf("missing file should return empty, got %q", got)
	}

	if err := SaveRelayID(path, "rly_abc123"); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err = LoadRelayID(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != "rly_abc123" {
		t.Errorf("got %q, want rly_abc123", got)
	}
}
