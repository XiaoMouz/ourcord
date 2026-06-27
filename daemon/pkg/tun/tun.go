// Package tun manages the OS-level TUN interface creation and WireGuard engine.
// Uses wireguard-go userspace implementation for cross-platform compatibility.
package tun

import (
	"fmt"
	"net/netip"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

const DefaultMTU = 1280 // Conservative MTU for VPN-over-VPN scenarios

// Interface wraps a TUN device and WireGuard device.
type Interface struct {
	tun    tun.Device
	device *device.Device
	name   string
	addrs  []netip.Prefix
}

// New creates a new TUN interface with the given name and VPN addresses.
//
// On Darwin the kernel chooses the actual `utunN` name; the returned
// Interface.Name() reflects the assigned name regardless of what was
// requested. The OS-level addresses in `addrs` are configured via
// platform-specific helpers (see addr_linux.go / addr_darwin.go); failure
// to assign addresses tears down the freshly created TUN to avoid leaving
// a half-configured interface around.
func New(name string, addrs []netip.Prefix) (*Interface, error) {
	return NewWithBind(name, addrs, conn.NewDefaultBind())
}

// NewWithBind creates a TUN interface using a caller-provided WireGuard bind.
// Daemon uses this for DERP-first hybrid transport; tests and simple local
// operation can keep using New.
func NewWithBind(name string, addrs []netip.Prefix, bind conn.Bind) (*Interface, error) {
	tunDev, err := tun.CreateTUN(name, DefaultMTU)
	if err != nil {
		return nil, fmt.Errorf("create tun %q: %w", name, err)
	}
	actualName, err := tunDev.Name()
	if err != nil {
		_ = tunDev.Close()
		return nil, fmt.Errorf("tun name: %w", err)
	}

	if len(addrs) > 0 {
		if err := assignAddrs(actualName, addrs); err != nil {
			_ = tunDev.Close()
			return nil, fmt.Errorf("assign addrs to %s: %w", actualName, err)
		}
	}
	if err := enableForwarding(actualName); err != nil {
		_ = tunDev.Close()
		return nil, fmt.Errorf("enable forwarding for %s: %w", actualName, err)
	}

	logger := device.NewLogger(device.LogLevelError, fmt.Sprintf("[wg/%s] ", actualName))
	wgDev := device.NewDevice(tunDev, bind, logger)

	iface := &Interface{
		tun:    tunDev,
		device: wgDev,
		name:   actualName,
		addrs:  addrs,
	}

	return iface, nil
}

// Device returns the underlying WireGuard device for configuration.
func (i *Interface) Device() *device.Device { return i.device }

// Name returns the TUN interface name.
func (i *Interface) Name() string { return i.name }

// Up brings the WireGuard device up.
func (i *Interface) Up() error {
	i.device.Up()
	return nil
}

// Close shuts down the TUN interface and WireGuard device.
func (i *Interface) Close() error {
	i.device.Close()
	return i.tun.Close()
}

// ConfigureIPC applies a WireGuard IPC config string to the device.
// The config format follows the wg(8) UAPI protocol.
func (i *Interface) ConfigureIPC(ipcConfig string) error {
	return i.device.IpcSet(ipcConfig)
}

// GetIPC reads the current WireGuard IPC state.
func (i *Interface) GetIPC() (string, error) {
	return i.device.IpcGet()
}

// SyncPeerV4Routes installs OS-level /32 routes for each addr to dev <name>
// and removes any /32 routes on the interface that aren't in `want`.
//
// Background: with userspace wireguard-go we don't get automatic kernel route
// installation from AllowedIPs. The interface's own /32 (or /128) only covers
// "self". For peer traffic to actually hit the tun, the kernel needs a route
// for each peer's VPN IP. We deliberately add /32 host routes (instead of a
// blanket /15 covering the whole pool) so that:
//   - We don't shadow ISP CGNAT / Tailscale / other unrelated 198.18 use
//   - Removing a peer cleanly unhooks its route
//   - The route table reflects actual mesh membership for debugging
func (i *Interface) SyncPeerV4Routes(want []netip.Addr) error {
	return syncPeerV4Routes(i.name, want)
}
