package wg

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadOrCreateKeyPair_GeneratesAndPersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "wg.key")

	kp1, err := LoadOrCreateKeyPair(path)
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if kp1 == nil {
		t.Fatal("nil key pair")
	}

	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := st.Mode().Perm(); mode != 0o600 {
		t.Errorf("file mode = %o, want 0600", mode)
	}

	kp2, err := LoadOrCreateKeyPair(path)
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if kp1.PublicKeyBase64() != kp2.PublicKeyBase64() {
		t.Errorf("public key changed across reload: %s vs %s",
			kp1.PublicKeyBase64(), kp2.PublicKeyBase64())
	}
}

func TestLoadOrCreateKeyPair_RejectsBadFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wg.key")
	if err := os.WriteFile(path, []byte("not-base64-!!!"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateKeyPair(path); err == nil {
		t.Error("expected decode error, got nil")
	}
}

func TestLoadOrCreateKeyPair_EmptyPath(t *testing.T) {
	if _, err := LoadOrCreateKeyPair(""); err == nil {
		t.Error("expected error on empty path")
	}
}
