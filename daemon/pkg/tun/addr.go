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
