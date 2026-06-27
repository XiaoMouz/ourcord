//go:build linux

package tun

import (
	"os"
	"testing"
)

func TestWriteSysctlOneAlreadyEnabled(t *testing.T) {
	t.Parallel()
	path := t.TempDir() + "/forwarding"
	if err := os.WriteFile(path, []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeSysctlOne(path); err != nil {
		t.Fatalf("writeSysctlOne: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "1\n" {
		t.Fatalf("unexpected content: %q", got)
	}
}

func TestWriteSysctlOneEnablesZero(t *testing.T) {
	t.Parallel()
	path := t.TempDir() + "/forwarding"
	if err := os.WriteFile(path, []byte("0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeSysctlOne(path); err != nil {
		t.Fatalf("writeSysctlOne: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "1\n" {
		t.Fatalf("unexpected content: %q", got)
	}
}

func TestWriteSysctlValueDisablesOne(t *testing.T) {
	t.Parallel()
	path := t.TempDir() + "/send_redirects"
	if err := os.WriteFile(path, []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeSysctlValue(path, "0"); err != nil {
		t.Fatalf("writeSysctlValue: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "0\n" {
		t.Fatalf("unexpected content: %q", got)
	}
}
