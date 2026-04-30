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
