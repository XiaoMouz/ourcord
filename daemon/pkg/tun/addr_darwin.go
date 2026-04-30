//go:build darwin

package tun

import (
	"fmt"
	"net/netip"
	"os/exec"
)

// assignAddrs uses ifconfig to attach v4/v6 addresses to a utunN interface.
//
// macOS `utun` is point-to-point; ifconfig requires `inet <addr> <peer>` even
// when there is no real peer address (we use the same addr for both). The
// interface comes up automatically once an address is assigned but we run an
// explicit `ifconfig <if> up` for safety.
func assignAddrs(ifname string, addrs []netip.Prefix) error {
	for _, a := range addrs {
		var args []string
		if a.Addr().Is4() {
			args = []string{ifname, "inet", a.String(), a.Addr().String()}
		} else {
			args = []string{ifname, "inet6", a.String()}
		}
		if out, err := exec.Command("ifconfig", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("ifconfig %v: %w (%s)", args, err, string(out))
		}
	}
	if out, err := exec.Command("ifconfig", ifname, "up").CombinedOutput(); err != nil {
		return fmt.Errorf("ifconfig %s up: %w (%s)", ifname, err, string(out))
	}
	return nil
}
