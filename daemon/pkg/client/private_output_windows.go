package client

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// openPrivateOutput creates the file with a protected DACL. For an existing
// file it verifies the owner and restricts the same open handle before
// truncating, so the new contents are never written under an inherited ACL.
func openPrivateOutput(path string) (*os.File, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + user.User.Sid.String() + ")")
	if err != nil {
		return nil, err
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE|windows.READ_CONTROL|windows.WRITE_DAC,
		0, &sa, windows.OPEN_ALWAYS, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open private output", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(handle), path)
	if err := restrictPrivateOutput(handle, user.User.Sid, sd); err != nil {
		file.Close()
		return nil, &os.PathError{Op: "secure private output", Path: path, Err: err}
	}
	if err := file.Truncate(0); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func restrictPrivateOutput(handle windows.Handle, user *windows.SID, sd *windows.SECURITY_DESCRIPTOR) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 || info.NumberOfLinks != 1 {
		return errors.New("expected a regular file with a single link")
	}
	current, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := current.Owner()
	if err != nil {
		return err
	}
	if owner == nil || !(owner.Equals(user) || owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid)) {
		return errors.New("unexpected file owner")
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}
