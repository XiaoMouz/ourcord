//go:build !linux && !darwin

package tun

import (
	"fmt"
	"net/netip"
)

// assignAddrs is a placeholder for unsupported platforms. Windows support
// (wintun + netsh / IP Helper API) is tracked as a Phase-2 deliverable.
func assignAddrs(ifname string, addrs []netip.Prefix) error {
	_ = addrs
	return fmt.Errorf("tun: OS address assignment not implemented on this platform (interface=%s); see plan.md W1 / Phase-2", ifname)
}

// syncPeerV4Routes is a placeholder; same Phase-2 deliverable as assignAddrs.
func syncPeerV4Routes(ifname string, want []netip.Addr) error {
	_ = want
	return fmt.Errorf("tun: per-peer route sync not implemented on this platform (interface=%s)", ifname)
}
