//go:build !windows

package media

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func lockCounterFile(f *os.File) error { return unix.Flock(int(f.Fd()), unix.LOCK_EX) }
func unlockCounterFile(f *os.File)     { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN) }

func replaceCounterFile(from, to string) error {
	if err := os.Rename(from, to); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(to))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
