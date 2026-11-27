package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// The installer runs the copy it just installed. Use its actual executable
// path for both fresh registration and upgrades to another directory.
func configureInstalledService() error {
	image, err := os.Executable()
	if err != nil {
		return err
	}
	sysDir, err := windows.GetSystemDirectory()
	if err != nil {
		return err
	}
	return configureService(image, func(args ...string) error {
		cmd := exec.Command(filepath.Join(sysDir, "sc.exe"), args...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		err := cmd.Run()
		var failure *exec.ExitError
		if errors.As(err, &failure) {
			return fmt.Errorf("sc %s: %w", args[0], windows.Errno(failure.ExitCode()))
		}
		return err
	})
}

func configureService(image string, run func(...string) error) error {
	// sc.exe needs the quotes in the ImagePath value stored by the SCM.
	// os/exec separately handles quoting each argument for the sc.exe process.
	settings := []string{serviceName, "binPath=", `"` + image + `"`, "start=", "delayed-auto", "DisplayName=", "OurCord Network Service"}
	err := run(append([]string{"create"}, settings...)...)
	if errors.Is(err, windows.ERROR_SERVICE_EXISTS) {
		err = run(append([]string{"config"}, settings...)...)
	}
	if err != nil {
		return err
	}
	if err := run("failure", serviceName, "reset=", "86400", "actions=", "restart/5000/restart/15000/restart/60000"); err != nil {
		return err
	}
	return run("start", serviceName)
}
