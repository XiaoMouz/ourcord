//go:build !windows

package client

import (
	"os"
	"testing"
)

func assertPrivateOutput(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("private output mode = %v, want 0600", info.Mode().Perm())
	}
}
