//go:build !windows

package client

import "os"

func createPrivateTempOutput(dir string) (*os.File, error) {
	return os.CreateTemp(dir, ".ourcord-diagnostics-*")
}

func replaceDiagnosticsOutput(tempPath, destPath string) error {
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
