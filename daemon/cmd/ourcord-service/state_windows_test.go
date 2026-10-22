package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func stateDACL(t *testing.T, path string) string {
	t.Helper()
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	return descriptor.String()
}

func TestSecureStateDirectoryProtectsNewFiles(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "OurCord")
	if err := secureStateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	dacl := stateDACL(t, directory)
	if !strings.HasPrefix(dacl, "D:P") || !strings.Contains(dacl, ";;;SY)") || !strings.Contains(dacl, ";;;BA)") {
		t.Fatalf("unexpected directory DACL: %s", dacl)
	}
	keyPath := filepath.Join(directory, "wg.key")
	if err := os.WriteFile(keyPath, []byte("test-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	assertPrivateStateDACL(t, keyPath)
	if err := secureStateDirectory(directory); err != nil {
		t.Fatalf("repeated startup: %v", err)
	}
}

func assertPrivateStateDACL(t *testing.T, path string) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl == nil || dacl.AceCount != 3 {
		t.Fatalf("unexpected access entries: %s", descriptor.String())
	}
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var entry *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &entry); err != nil {
			t.Fatal(err)
		}
		if entry.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			t.Fatalf("unexpected ACE type: %s", descriptor.String())
		}
		principal := (*windows.SID)(unsafe.Pointer(&entry.SidStart))
		if !principal.IsWellKnown(windows.WinLocalSystemSid) && !principal.IsWellKnown(windows.WinBuiltinAdministratorsSid) && !principal.Equals(user.User.Sid) {
			t.Fatalf("unexpected access grant: %s", descriptor.String())
		}
	}
}

func TestSecureStateDirectoryRepairsInheritedPermissions(t *testing.T) {
	parent := t.TempDir()
	descriptor, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(parent, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(parent, "OurCord")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(directory, "device.token")
	if err := os.WriteFile(keyPath, []byte("test-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stateDACL(t, keyPath), ";;;WD)") {
		t.Fatal("fixture did not inherit broad access")
	}
	if err := secureStateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	assertPrivateStateDACL(t, directory)
	assertPrivateStateDACL(t, keyPath)
	data, err := os.ReadFile(keyPath)
	if err != nil || string(data) != "test-token" {
		t.Fatalf("existing state changed: %q %v", data, err)
	}
}

func TestSecureStateDirectoryRejectsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "OurCord")
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := secureStateDirectory(path); err == nil {
		t.Fatal("accepted a regular file as state directory")
	}
}

func TestSecureStateDirectoryRejectsSymlink(t *testing.T) {
	parent := t.TempDir()
	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	before := stateDACL(t, target)
	link := filepath.Join(parent, "OurCord")
	if err := os.Symlink(target, link); err != nil {
		if errors.Is(err, windows.ERROR_PRIVILEGE_NOT_HELD) {
			t.Skip("creating symlinks requires Windows developer mode or symlink privilege")
		}
		t.Fatal(err)
	}
	if err := secureStateDirectory(link); err == nil {
		t.Fatal("accepted a symlink as state directory")
	}
	if after := stateDACL(t, target); after != before {
		t.Fatalf("symlink target permissions changed: %s -> %s", before, after)
	}
}

func TestDaemonCommandSecuresStateBeforeStarting(t *testing.T) {
	parent := t.TempDir()
	t.Setenv("ProgramData", parent)
	command, err := daemonCommand()
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(parent, "OurCord")
	assertPrivateStateDACL(t, directory)
	if len(command.Args) < 3 || command.Args[1] != "--state-dir" || command.Args[2] != directory {
		t.Fatalf("unexpected daemon command arguments: %v", command.Args)
	}
}
