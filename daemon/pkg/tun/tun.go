// Package tun manages the OS-level TUN interface creation and WireGuard engine.
// Uses wireguard-go userspace implementation for cross-platform compatibility.
package tun

import (
	"fmt"
	"net/netip"

	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/conn"
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
func New(name string, addrs []netip.Prefix) (*Interface, error) {
	tunDev, err := tun.CreateTUN(name, DefaultMTU)
	if err != nil {
		return nil, fmt.Errorf("create tun %q: %w", name, err)
	}

	logger := device.NewLogger(device.LogLevelError, fmt.Sprintf("[wg/%s] ", name))
	wgDev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)

	iface := &Interface{
		tun:    tunDev,
		device: wgDev,
		name:   name,
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
