//go:build darwin

package tun

import (
	"fmt"
	"net/netip"
	"os/exec"
	"strings"
)

// assignAddrs uses ifconfig to attach v4/v6 addresses to a utunN interface.
//
// macOS `utun` is point-to-point; ifconfig requires `inet <addr> <peer>` even
// when there is no real peer address (we use the same addr for both). The
// interface comes up automatically once an address is assigned but we run an
// explicit `ifconfig <if> up` for safety.
//
// Additionally installs the v6 lobby ULA /48 route on the interface so all
// VPN v6 traffic is routed via tun. v4 peer /32 routes are installed
// dynamically by syncPeerV4Routes as peers are learned.
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
		if a.Addr().Is6() {
			ula48 := ULA48(a.Addr())
			out, err := exec.Command("route", "-n", "add", "-inet6", "-net", ula48.String(), "-interface", ifname).CombinedOutput()
			if err != nil && !routeExistsErr(out) {
				return fmt.Errorf("route add -inet6 %s -interface %s: %w (%s)", ula48, ifname, err, string(out))
			}
		}
	}
	if out, err := exec.Command("ifconfig", ifname, "up").CombinedOutput(); err != nil {
		return fmt.Errorf("ifconfig %s up: %w (%s)", ifname, err, string(out))
	}
	return nil
}

func syncPeerV4Routes(ifname string, want []netip.Addr) error {
	have, err := listV4HostRoutesOnDevDarwin(ifname)
	if err != nil {
		return err
	}
	toAdd, toDel := DiffV4Routes(have, want)
	for _, a := range toAdd {
		out, err := exec.Command("route", "-n", "add", "-inet", "-host", a.String(), "-interface", ifname).CombinedOutput()
		if err != nil && !routeExistsErr(out) {
			return fmt.Errorf("route add -host %s -interface %s: %w (%s)", a, ifname, err, string(out))
		}
	}
	for _, a := range toDel {
		out, err := exec.Command("route", "-n", "delete", "-inet", "-host", a.String(), "-interface", ifname).CombinedOutput()
		if err != nil && !routeMissingErr(out) {
			return fmt.Errorf("route delete -host %s -interface %s: %w (%s)", a, ifname, err, string(out))
		}
	}
	return nil
}

// listV4HostRoutesOnDevDarwin parses `netstat -rn -f inet` for /32 routes
// pointing at <ifname>. macOS doesn't have an `ip route show dev <if>`
// equivalent that filters by interface; we do it client-side.
func listV4HostRoutesOnDevDarwin(ifname string) (map[netip.Addr]struct{}, error) {
	out, err := exec.Command("netstat", "-rn", "-f", "inet").Output()
	if err != nil {
		return nil, fmt.Errorf("netstat -rn: %w", err)
	}
	res := map[netip.Addr]struct{}{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// Expected columns on macOS: Destination Gateway Flags Netif Expire
		if len(fields) < 4 {
			continue
		}
		if fields[len(fields)-2] != ifname && (len(fields) < 4 || fields[3] != ifname) {
			// netstat columns vary; check both common positions
			continue
		}
		dest := fields[0]
		// Host route on macOS is usually shown as the bare address.
		// Skip default / network entries containing "/" with non-32.
		if idx := strings.Index(dest, "/"); idx >= 0 {
			if dest[idx+1:] != "32" {
				continue
			}
			dest = dest[:idx]
		}
		a, err := netip.ParseAddr(dest)
		if err != nil || !a.Is4() {
			continue
		}
		res[a] = struct{}{}
	}
	return res, nil
}

func routeExistsErr(out []byte) bool {
	s := string(out)
	return strings.Contains(s, "File exists") || strings.Contains(s, "route already in table")
}

func routeMissingErr(out []byte) bool {
	s := string(out)
	return strings.Contains(s, "not in table") || strings.Contains(s, "no such process")
}
