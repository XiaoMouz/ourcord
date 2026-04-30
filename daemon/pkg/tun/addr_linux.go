//go:build linux

package tun

import (
	"fmt"
	"net/netip"
	"os/exec"
)

// assignAddrs uses iproute2 to bring the interface up and add v4/v6 addresses.
// We shell out instead of linking netlink to keep the dependency surface small;
// this also matches how operators debug TUN interfaces (`ip addr show <iface>`).
func assignAddrs(ifname string, addrs []netip.Prefix) error {
	if out, err := exec.Command("ip", "link", "set", "dev", ifname, "up").CombinedOutput(); err != nil {
		return fmt.Errorf("ip link set %s up: %w (%s)", ifname, err, string(out))
	}
	for _, a := range addrs {
		family := "-4"
		if a.Addr().Is6() {
			family = "-6"
		}
		out, err := exec.Command("ip", family, "addr", "add", a.String(), "dev", ifname).CombinedOutput()
		if err != nil {
			return fmt.Errorf("ip %s addr add %s dev %s: %w (%s)", family, a, ifname, err, string(out))
		}
	}
	return nil
}
