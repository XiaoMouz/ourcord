// Package-level documentation for the assignAddrs interface implemented in
// addr_linux.go / addr_darwin.go / addr_other.go. assignAddrs configures
// OS-level IP addresses on the freshly created TUN interface so the kernel
// routes the VPN address space into our userspace WireGuard device. Without
// this step `tun.CreateTUN` only creates a bare interface with no addresses
// and userland traffic to the VPN IPs never reaches the wg engine.
//
// Phase-1 implementation uses platform shell-outs (`ip` on Linux, `ifconfig`
// on Darwin) for portability without pulling in netlink/wintun deps. Phase-2
// may upgrade to native syscalls.
package tun

import (
	"crypto/rand"
	"fmt"
	"io"
	"net/netip"
	"sort"
)

// VPNv4Pool is the IPv4 pool reserved for VPN-internal addressing. Its
// boundaries (198.18.0.0 .. 198.19.255.255) are RFC 2544 benchmarking
// space, chosen so we don't collide with public allocations or RFC 1918
// home networks. AssignAddrs / SyncPeerV4Routes refuse addresses outside
// this prefix to keep operator mistakes from inserting routes for, e.g.,
// 8.8.8.8 into the VPN table.
var VPNv4Pool = netip.MustParsePrefix("198.18.0.0/15")

// IsValidVPNv4 reports whether addr is a usable IPv4 address inside the
// VPN pool. Returns false for IPv6, invalid addrs, and v4 addrs outside
// 198.18.0.0/15.
func IsValidVPNv4(addr netip.Addr) bool {
	if !addr.IsValid() || !addr.Is4() {
		return false
	}
	return VPNv4Pool.Contains(addr)
}

// IsULA reports whether addr is an IPv6 Unique Local Address (fc00::/7
// per RFC 4193). The lobby ULA assignments live inside this range.
func IsULA(addr netip.Addr) bool {
	if !addr.IsValid() || !addr.Is6() {
		return false
	}
	b := addr.As16()
	return b[0]&0xfe == 0xfc
}

// ULA48 returns the /48 ULA prefix that contains addr, masked. Useful for
// computing the lobby route to install on the TUN. Caller is responsible
// for ensuring addr is a v6 ULA (see IsULA); behavior is unspecified
// otherwise.
func ULA48(addr netip.Addr) netip.Prefix {
	return netip.PrefixFrom(addr, 48).Masked()
}

// GenerateSessionULA produces a random /128 ULA address of the form
// fdXX:XXXX:XXXX::1 sourced from r. Per the U-series migration each
// daemon session picks a fresh ULA so old leases on disk can't shadow
// the current mesh. The returned addr is always a valid v6 ULA with the
// L bit set (locally assigned, fd00::/8).
func GenerateSessionULA(r io.Reader) (netip.Addr, error) {
	if r == nil {
		r = rand.Reader
	}
	var b [16]byte
	if _, err := io.ReadFull(r, b[:6]); err != nil {
		return netip.Addr{}, fmt.Errorf("read random ULA prefix: %w", err)
	}
	b[0] = 0xfd // RFC 4193: fd00::/8 (locally assigned half of fc00::/7).
	// Host suffix ::1 — daemon claims the first address in its own ULA /48.
	b[15] = 0x01
	return netip.AddrFrom16(b), nil
}

// DiffV4Routes computes the set difference between currently installed
// /32 host routes (`have`) and the desired set (`want`). Returns the
// addresses to add (in want but not in have) and to delete (in have but
// not in want), both sorted for deterministic output. Invalid addrs and
// non-IPv4 addrs in `want` are silently dropped — they would never round-
// trip through `ip route show` anyway.
//
// Idempotent: calling twice with the same inputs yields the same diff;
// applying the diff and re-running yields empty add/del slices.
func DiffV4Routes(have map[netip.Addr]struct{}, want []netip.Addr) (toAdd, toDel []netip.Addr) {
	wantSet := make(map[netip.Addr]struct{}, len(want))
	for _, a := range want {
		if !a.IsValid() || !a.Is4() {
			continue
		}
		if _, dup := wantSet[a]; dup {
			continue
		}
		wantSet[a] = struct{}{}
		if _, ok := have[a]; !ok {
			toAdd = append(toAdd, a)
		}
	}
	for a := range have {
		if _, keep := wantSet[a]; !keep {
			toDel = append(toDel, a)
		}
	}
	sort.Slice(toAdd, func(i, j int) bool { return toAdd[i].Less(toAdd[j]) })
	sort.Slice(toDel, func(i, j int) bool { return toDel[i].Less(toDel[j]) })
	return toAdd, toDel
}

// AddrConfigurator abstracts OS-level address and route operations on a
// TUN interface. The default implementation (OSConfigurator) shells out
// to `ip` (Linux) or `ifconfig`/`route` (Darwin); tests inject a fake to
// record call ordering and verify idempotency without touching the
// kernel route table.
type AddrConfigurator interface {
	AssignAddrs(ifname string, addrs []netip.Prefix) error
	SyncPeerV4Routes(ifname string, want []netip.Addr) error
}

// OSConfigurator is the production AddrConfigurator that delegates to
// the platform-specific assignAddrs / syncPeerV4Routes helpers.
type OSConfigurator struct{}

func (OSConfigurator) AssignAddrs(ifname string, addrs []netip.Prefix) error {
	return assignAddrs(ifname, addrs)
}

func (OSConfigurator) SyncPeerV4Routes(ifname string, want []netip.Addr) error {
	return syncPeerV4Routes(ifname, want)
}
