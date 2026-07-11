//go:build !linux && !darwin && !windows

package tun

import (
	"fmt"
	"net/netip"
)

// assignAddrs is a placeholder for platforms without an OS address backend.
// Linux, Darwin, and Windows have real implementations (addr_{linux,darwin,windows}.go);
// anything else (e.g. *BSD) is unsupported until an equivalent is added.
func assignAddrs(ifname string, addrs []netip.Prefix) error {
	_ = addrs
	return fmt.Errorf("tun: OS address assignment not implemented on this platform (interface=%s)", ifname)
}

// syncPeerV4Routes is a placeholder for unsupported platforms; see assignAddrs.
func syncPeerV4Routes(ifname string, want []netip.Addr) error {
	_ = want
	return fmt.Errorf("tun: per-peer route sync not implemented on this platform (interface=%s)", ifname)
}

func enableForwarding(ifname string) error {
	_ = ifname
	return nil
}
