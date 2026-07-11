//go:build windows

package tun

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"golang.org/x/sys/windows"
	"golang.zx2c4.com/wireguard/windows/tunnel/winipcfg"
)

const (
	// A freshly created Wintun adapter can briefly be absent from the OS
	// interface table before net.InterfaceByName sees it, so ifaceLUID retries
	// the resolution for a bounded window (mirrors wireguard-windows).
	luidRetryAttempts = 10
	luidRetryDelay    = 200 * time.Millisecond
)

// Windows address/route configuration via the native IP Helper API (winipcfg),
// the analogue of the `ip` shell-outs in addr_linux.go. The TUN device itself is
// a Wintun adapter created by wireguard-go; here we only assign OS addresses and
// sync per-peer host routes. Every operation is keyed by the adapter LUID, which
// we resolve from the interface name the daemon already holds.

// ifaceLUID resolves a Wintun adapter's LUID from its interface name. Go's net
// package exposes the adapter's friendly name (the name wireguard-go assigned),
// and winipcfg converts the interface index to the LUID its API expects. The
// lookup is retried briefly because the adapter may not be listed the instant
// after CreateTUN returns.
func ifaceLUID(ifname string) (winipcfg.LUID, error) {
	var lastErr error
	for attempt := 0; attempt < luidRetryAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(luidRetryDelay)
		}
		iface, err := net.InterfaceByName(ifname)
		if err != nil {
			lastErr = fmt.Errorf("lookup interface %q: %w", ifname, err)
			continue
		}
		luid, err := winipcfg.LUIDFromIndex(uint32(iface.Index))
		if err != nil {
			lastErr = fmt.Errorf("luid for %q (index %d): %w", ifname, iface.Index, err)
			continue
		}
		return luid, nil
	}
	return 0, lastErr
}

// assignAddrs sets the interface's own v4/v6 VPN addresses and installs the
// lobby ULA /48 route for each v6 address, mirroring addr_linux.go. Wintun
// adapters come up on creation, so no explicit "link up" is needed.
func assignAddrs(ifname string, addrs []netip.Prefix) error {
	luid, err := ifaceLUID(ifname)
	if err != nil {
		return err
	}
	if err := luid.SetIPAddresses(addrs); err != nil {
		return fmt.Errorf("set addresses on %s: %w", ifname, err)
	}
	for _, a := range addrs {
		if !a.Addr().Is6() {
			continue
		}
		ula := ULA48(a.Addr())
		// EEXIST-equivalent is fine: a route may persist across daemon restarts.
		if err := luid.AddRoute(ula, netip.IPv6Unspecified(), 0); err != nil &&
			!errors.Is(err, windows.ERROR_OBJECT_ALREADY_EXISTS) {
			return fmt.Errorf("add ULA route %s on %s: %w", ula, ifname, err)
		}
	}
	return nil
}

// syncPeerV4Routes adds /32 host routes for each peer address and removes any
// interface /32 that isn't in `want`, idempotently — the same contract as the
// Linux implementation, using DiffV4Routes.
func syncPeerV4Routes(ifname string, want []netip.Addr) error {
	luid, err := ifaceLUID(ifname)
	if err != nil {
		return err
	}
	have, err := listV4HostRoutes(luid)
	if err != nil {
		return err
	}
	toAdd, toDel := DiffV4Routes(have, want)
	for _, a := range toAdd {
		dst := netip.PrefixFrom(a, 32)
		if err := luid.AddRoute(dst, netip.IPv4Unspecified(), 0); err != nil &&
			!errors.Is(err, windows.ERROR_OBJECT_ALREADY_EXISTS) {
			return fmt.Errorf("add route %s on %s: %w", dst, ifname, err)
		}
	}
	for _, a := range toDel {
		dst := netip.PrefixFrom(a, 32)
		if err := luid.DeleteRoute(dst, netip.IPv4Unspecified()); err != nil &&
			!errors.Is(err, windows.ERROR_NOT_FOUND) {
			return fmt.Errorf("del route %s on %s: %w", dst, ifname, err)
		}
	}
	return nil
}

// listV4HostRoutes returns the /32 routes currently installed on the interface,
// excluding the interface's own unicast addresses. Windows auto-creates an
// on-link /32 route for every assigned address; those are not peer routes and
// must never be diffed away (Linux avoids this because self-addresses live in
// the `local` table, invisible to `ip route show dev`).
func listV4HostRoutes(luid winipcfg.LUID) (map[netip.Addr]struct{}, error) {
	self, err := interfaceSelfV4(luid)
	if err != nil {
		return nil, err
	}
	rows, err := winipcfg.GetIPForwardTable2(windows.AF_INET)
	if err != nil {
		return nil, fmt.Errorf("read route table: %w", err)
	}
	res := map[netip.Addr]struct{}{}
	for i := range rows {
		if rows[i].InterfaceLUID != luid {
			continue
		}
		p := rows[i].DestinationPrefix.Prefix()
		if !p.IsValid() || p.Bits() != 32 || !p.Addr().Is4() {
			continue
		}
		a := p.Addr()
		if _, isSelf := self[a]; isSelf {
			continue
		}
		res[a] = struct{}{}
	}
	return res, nil
}

// interfaceSelfV4 enumerates the interface's own IPv4 unicast addresses.
func interfaceSelfV4(luid winipcfg.LUID) (map[netip.Addr]struct{}, error) {
	adapters, err := winipcfg.GetAdaptersAddresses(windows.AF_INET, winipcfg.GAAFlagDefault)
	if err != nil {
		return nil, fmt.Errorf("read adapter addresses: %w", err)
	}
	self := map[netip.Addr]struct{}{}
	for _, ad := range adapters {
		if ad.LUID != luid {
			continue
		}
		for ua := ad.FirstUnicastAddress; ua != nil; ua = ua.Next {
			na, ok := netip.AddrFromSlice(ua.Address.IP())
			if !ok {
				continue
			}
			self[na.Unmap()] = struct{}{}
		}
	}
	return self, nil
}

// enableForwarding turns on IP forwarding for both families so this host can act
// as the middle node of an A-B-C relay chain (WireGuard hands decrypted packets
// back into the same TUN for another peer). Windows has no per-interface
// send/accept-redirect knobs to mirror from Linux.
func enableForwarding(ifname string) error {
	luid, err := ifaceLUID(ifname)
	if err != nil {
		return err
	}
	for _, family := range []winipcfg.AddressFamily{windows.AF_INET, windows.AF_INET6} {
		row, err := luid.IPInterface(family)
		if err != nil {
			return fmt.Errorf("read ip interface (family %d) on %s: %w", family, ifname, err)
		}
		if row.ForwardingEnabled {
			continue
		}
		row.ForwardingEnabled = true
		if err := row.Set(); err != nil {
			return fmt.Errorf("enable forwarding (family %d) on %s: %w", family, ifname, err)
		}
	}
	return nil
}
