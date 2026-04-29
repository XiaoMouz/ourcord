//go:build !linux && !darwin

package ipc

import "net"

// checkPeerCred is a no-op fallback for platforms (e.g. Windows) where we
// don't currently have a peer-credential check wired up. Windows uses named
// pipes / DACLs for IPC ACLs anyway and would need a different transport;
// this stub keeps the build green until that is implemented.
func checkPeerCred(_ net.Conn) error { return nil }
