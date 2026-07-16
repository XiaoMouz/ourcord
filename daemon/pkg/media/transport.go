package media

import (
	"fmt"
	"net"
	"net/netip"
)

// VoicePort is the fixed UDP port the voice engine binds on the daemon's VPN
// address. Voice packets are ordinary UDP to a peer's 198.18.x VPN IP; the OS
// routes them through the TUN into WireGuard, and A-B-C relay forwarding is
// transparent, so no separate media transport is needed.
const VoicePort = 45820

// packetConn is the subset of net.PacketConn the engine uses (seam for tests).
type packetConn interface {
	WriteToUDPAddrPort([]byte, netip.AddrPort) (int, error)
	ReadFromUDPAddrPort([]byte) (int, netip.AddrPort, error)
	Close() error
}

// bindVoiceUDP binds VoicePort on the given VPN address. Binding to the VPN IP
// (not 0.0.0.0) keeps voice strictly on the overlay.
func bindVoiceUDP(vpnIP netip.Addr) (*net.UDPConn, error) {
	if !vpnIP.IsValid() {
		return nil, fmt.Errorf("media: invalid VPN address")
	}
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IP(vpnIP.AsSlice()), Port: VoicePort})
	if err != nil {
		return nil, fmt.Errorf("media: bind %s:%d: %w", vpnIP, VoicePort, err)
	}
	return conn, nil
}
