//go:build darwin

package ipc

import (
	"errors"
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

// checkPeerCred enforces that the peer connecting to the IPC socket has the
// configured UID. macOS exposes peer credentials via
// SOL_LOCAL / LOCAL_PEERCRED returning an Xucred (uid + gid list).
func checkPeerCred(conn net.Conn, allowedUID int) error {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return errors.New("ipc: non-unix conn cannot be authorized")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return err
	}
	var (
		cred    *unix.Xucred
		sockErr error
	)
	err = raw.Control(func(fd uintptr) {
		cred, sockErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	})
	if err != nil {
		return err
	}
	if sockErr != nil {
		return sockErr
	}
	if int(cred.Uid) != allowedUID {
		return fmt.Errorf("ipc: peer uid %d != allowed uid %d", cred.Uid, allowedUID)
	}
	return nil
}
