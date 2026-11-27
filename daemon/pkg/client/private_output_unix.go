//go:build !windows

package client

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func createPrivateTempOutput(dir string) (*os.File, error) {
	return os.CreateTemp(dir, ".ourcord-diagnostics-*")
}

func replaceDiagnosticsOutput(tempPath, destPath string) error {
	info, err := os.Lstat(destPath)
	if errors.Is(err, os.ErrNotExist) {
		return os.Rename(tempPath, destPath)
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return &os.PathError{Op: "replace diagnostics", Path: destPath, Err: unix.EINVAL}
	}
	// A directory may be writable even when the target is read-only.
	// Check effective file access, including any filesystem ACL, before rename.
	file, err := os.OpenFile(destPath, os.O_WRONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	opened, statErr := file.Stat()
	if err := errors.Join(statErr, file.Close()); err != nil {
		return err
	}
	if !os.SameFile(info, opened) {
		return &os.PathError{Op: "replace diagnostics", Path: destPath, Err: unix.ESTALE}
	}
	return os.Rename(tempPath, destPath)
}

func openPrivateOutput(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
