//go:build linux

package ipc

import (
	"errors"
	"fmt"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// checkPeerCred enforces that the peer connecting to the IPC socket is the
// same UID as this process. The IPC commands (connect/disconnect/shutdown)
// are privileged; allowing other local users to invoke them would let any
// shell user on the box take down or hijack the VPN.
//
// Linux exposes this via SO_PEERCRED on the AF_UNIX socket — the kernel
// records the caller's UID/GID/PID at the moment of connect.
func checkPeerCred(conn net.Conn) error {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return errors.New("ipc: non-unix conn cannot be authorized")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return err
	}
	var cred *unix.Ucred
	var sockErr error
	err = raw.Control(func(fd uintptr) {
		cred, sockErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	})
	if err != nil {
		return err
	}
	if sockErr != nil {
		return sockErr
	}
	if int(cred.Uid) != os.Getuid() {
		return fmt.Errorf("ipc: peer uid %d != daemon uid %d", cred.Uid, os.Getuid())
	}
	return nil
}
