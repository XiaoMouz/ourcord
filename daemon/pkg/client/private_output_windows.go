package client

import (
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// openPrivateOutput creates the file with a protected DACL. For an existing
// file it verifies the owner and restricts the same open handle before
// truncating, so the new contents are never written under an inherited ACL.
func openPrivateOutput(path string) (*os.File, error) {
	return openWindowsPrivateOutput(path, windows.OPEN_ALWAYS)
}

func createPrivateTempOutput(dir string) (*os.File, error) {
	path := filepath.Join(dir, ".ourcord-diagnostics-"+rand.Text())
	return openWindowsPrivateOutput(path, windows.CREATE_NEW)
}

func openWindowsPrivateOutput(path string, disposition uint32) (_ *os.File, err error) {
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
		0, &sa, disposition, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open private output", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(handle), path)
	defer func() {
		if err != nil {
			err = errors.Join(err, file.Close())
			if disposition == windows.CREATE_NEW {
				err = errors.Join(err, os.Remove(path))
			}
		}
	}()
	if err := securePrivateOutput(handle, user.User.Sid, sd); err != nil {
		return nil, &os.PathError{Op: "secure private output", Path: path, Err: err}
	}
	if err := file.Truncate(0); err != nil {
		return nil, err
	}
	return file, nil
}

func securePrivateOutput(handle windows.Handle, user *windows.SID, sd *windows.SECURITY_DESCRIPTOR) error {
	if err := checkPrivateOutput(handle, user); err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

func checkPrivateOutput(handle windows.Handle, user *windows.SID) error {
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
	return nil
}

// Validate an existing destination without changing its contents or ACL.
// The rename replaces the directory entry with our completed private file.
func replaceDiagnosticsOutput(tempPath, destPath string) error {
	name, err := windows.UTF16PtrFromString(destPath)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_WRITE|windows.READ_CONTROL|windows.WRITE_DAC,
		0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
		// Publish only if the destination is still absent.
		from, err := windows.UTF16PtrFromString(tempPath)
		if err != nil {
			return err
		}
		return windows.MoveFileEx(from, name, 0)
	}
	if err != nil {
		return err
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err == nil {
		err = checkPrivateOutput(handle, user.User.Sid)
	}
	if err := errors.Join(err, windows.CloseHandle(handle)); err != nil {
		return err
	}
	return os.Rename(tempPath, destPath)
}
