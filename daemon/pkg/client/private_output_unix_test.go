//go:build !windows

package client

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDiagnosticsExportRefusesReadOnlyFile(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can open a mode-0400 file for writing")
	}
	path := filepath.Join(t.TempDir(), "diagnostics.zip")
	if err := os.WriteFile(path, []byte("previous export"), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := writeDiagnosticsArchive(path, "socket", "", nil, nil); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("export to read-only file = %v, want permission error", err)
	}
	content, err := os.ReadFile(path)
	if err != nil || string(content) != "previous export" {
		t.Fatalf("read-only file changed: %q (%v)", content, err)
	}
}

func TestDiagnosticsExportPreservesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "original.zip")
	if err := os.WriteFile(target, []byte("previous export"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.zip")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := writeDiagnosticsArchive(link, "socket", "", nil, nil); err == nil {
		t.Fatal("export to symlink must fail")
	}
	resolved, err := os.Readlink(link)
	if err != nil || resolved != target {
		t.Fatalf("link changed: %q (%v)", resolved, err)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "previous export" {
		t.Fatalf("linked file changed: %q (%v)", content, err)
	}
}

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
