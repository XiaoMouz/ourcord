//go:build windows

// ourcord-service is the Windows SCM host for the cross-platform daemon.
// Keeping SCM concerns in this tiny wrapper lets ourcordd remain a normal
// foreground process for CLI development and all other platforms.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"golang.org/x/sys/windows/svc"
)

const serviceName = "OurCordDaemon"

type handler struct{}

func (handler) Execute(_ []string, requests <-chan svc.ChangeRequest, statuses chan<- svc.Status) (bool, uint32) {
	statuses <- svc.Status{State: svc.StartPending}
	cmd, err := daemonCommand()
	if err != nil {
		return false, 1
	}
	if err := cmd.Start(); err != nil {
		return false, 2
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	statuses <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case <-done:
			return false, 3
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				statuses <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
			case svc.Stop, svc.Shutdown:
				statuses <- svc.Status{State: svc.StopPending}
				_ = cmd.Process.Kill()
				<-done
				return false, 0
			}
		}
	}
}

func daemonCommand() (*exec.Cmd, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	stateDir := filepath.Join(programData, "OurCord")
	if err := secureStateDirectory(stateDir); err != nil {
		return nil, err
	}
	daemonPath := filepath.Join(filepath.Dir(exe), "ourcordd.exe")
	return exec.Command(daemonPath,
		"--state-dir", stateDir,
		"--socket", `\\.\pipe\ourcordd`,
		"--log-file", filepath.Join(stateDir, "daemon.log"),
	), nil
}

func main() {
	interactive, err := svc.IsAnInteractiveSession()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if interactive {
		cmd, err := daemonCommand()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err := svc.Run(serviceName, handler{}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
