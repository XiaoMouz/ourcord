package client

import (
	"maps"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func assertPrivateOutput(t *testing.T, path string) {
	t.Helper()
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	flags, _, err := sd.Control()
	if err != nil || flags&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("private output DACL must be protected: %s (%v)", sd.String(), err)
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		t.Fatalf("private output DACL: %s (%v)", sd.String(), err)
	}
	got := make(map[string]bool)
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			t.Fatal(err)
		}
		const fileAllAccess = windows.STANDARD_RIGHTS_REQUIRED | windows.SYNCHRONIZE | 0x1ff
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask != fileAllAccess {
			t.Fatalf("unexpected grant: %s", sd.String())
		}
		got[(*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()] = true
	}
	want := map[string]bool{"S-1-5-18": true, "S-1-5-32-544": true, user.User.Sid.String(): true}
	if !maps.Equal(got, want) {
		t.Fatalf("access granted to %v, want %v", got, want)
	}
}
