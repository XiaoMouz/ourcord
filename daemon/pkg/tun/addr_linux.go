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
//
// Additionally installs the v6 lobby ULA /48 route on the interface so all
// VPN v6 traffic is routed via tun. v4 peer /32 routes are installed
// dynamically by SyncPeerV4Routes as peers are learned (avoids reserving a
// whole /15 and shadowing potential local infra).
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
		if a.Addr().Is6() {
			ula48 := ULA48(a.Addr())
			out, err := exec.Command("ip", "-6", "route", "add", ula48.String(), "dev", ifname).CombinedOutput()
			// EEXIST is fine: route may persist across daemon restarts.
			if err != nil && !routeExistsErr(out) {
				return fmt.Errorf("ip -6 route add %s dev %s: %w (%s)", ula48, ifname, err, string(out))
			}
		}
	}
	return nil
}

// syncPeerV4Routes adds /32 host routes for each addr to dev <ifname> and
// removes any /32 routes on the interface that aren't in `want`. Idempotent.
func syncPeerV4Routes(ifname string, want []netip.Addr) error {
	have, err := listV4HostRoutesOnDev(ifname)
	if err != nil {
		return err
	}
	toAdd, toDel := DiffV4Routes(have, want)
	for _, a := range toAdd {
		out, err := exec.Command("ip", "-4", "route", "add", a.String()+"/32", "dev", ifname).CombinedOutput()
		if err != nil && !routeExistsErr(out) {
			return fmt.Errorf("ip route add %s/32 dev %s: %w (%s)", a, ifname, err, string(out))
		}
	}
	for _, a := range toDel {
		out, err := exec.Command("ip", "-4", "route", "del", a.String()+"/32", "dev", ifname).CombinedOutput()
		if err != nil && !routeMissingErr(out) {
			return fmt.Errorf("ip route del %s/32 dev %s: %w (%s)", a, ifname, err, string(out))
		}
	}
	return nil
}

func listV4HostRoutesOnDev(ifname string) (map[netip.Addr]struct{}, error) {
	out, err := exec.Command("ip", "-4", "-o", "route", "show", "dev", ifname).Output()
	if err != nil {
		return nil, fmt.Errorf("ip route show dev %s: %w", ifname, err)
	}
	res := map[netip.Addr]struct{}{}
	for _, line := range splitLines(string(out)) {
		// lines look like:  198.18.0.10 proto kernel scope link
		var first string
		for i, c := range line {
			if c == ' ' || c == '\t' {
				first = line[:i]
				break
			}
		}
		if first == "" {
			first = line
		}
		// Only /32 host routes (no slash, or /32 explicit) without a "via"
		var addrPart string
		if idx := indexOf(first, "/"); idx >= 0 {
			if first[idx+1:] != "32" {
				continue
			}
			addrPart = first[:idx]
		} else {
			addrPart = first
		}
		a, err := netip.ParseAddr(addrPart)
		if err != nil || !a.Is4() {
			continue
		}
		res[a] = struct{}{}
	}
	return res, nil
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func routeExistsErr(out []byte) bool {
	s := string(out)
	return indexOf(s, "File exists") >= 0 || indexOf(s, "RTNETLINK answers: File exists") >= 0
}

func routeMissingErr(out []byte) bool {
	s := string(out)
	return indexOf(s, "No such process") >= 0 || indexOf(s, "Cannot find") >= 0
}
