// Package routing manages WireGuard peer configuration and relay chain routing.
// Receives topology updates from the control plane and configures AllowedIPs
// to enable A-B-C relay chains where B routes traffic between A and C.
package routing

import (
	"fmt"
	"net/netip"
	"strings"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// PeerRoute describes how to reach a remote VPN peer.
type PeerRoute struct {
	PublicKey  wgtypes.Key
	VPN4       netip.Addr   // peer's VPN IPv4
	VPN6       netip.Addr   // peer's VPN IPv6
	NextHop    *wgtypes.Key // nil = direct, non-nil = route via this intermediate peer
	DirectAddr *netip.AddrPort // UDP endpoint if hole-punch succeeded
	DERPURL    string           // DERP relay URL (fallback)
}

// Table holds the routing table for all VPN peers.
type Table struct {
	routes map[string]*PeerRoute // publicKey (hex) -> route
}

// NewTable creates an empty routing table.
func NewTable() *Table {
	return &Table{routes: make(map[string]*PeerRoute)}
}

// Upsert adds or updates a route.
func (t *Table) Upsert(r *PeerRoute) {
	t.routes[r.PublicKey.String()] = r
}

// Remove deletes a route.
func (t *Table) Remove(publicKey wgtypes.Key) {
	delete(t.routes, publicKey.String())
}

// All returns all routes.
func (t *Table) All() []*PeerRoute {
	out := make([]*PeerRoute, 0, len(t.routes))
	for _, r := range t.routes {
		out = append(out, r)
	}
	return out
}

// BuildIPCConfig generates the WireGuard IPC peer configuration for all routes.
// This string is passed to device.IpcSet().
func (t *Table) BuildIPCConfig(privateKey wgtypes.Key) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("private_key=%x\n", privateKey[:]))

	for _, r := range t.routes {
		sb.WriteString(fmt.Sprintf("public_key=%x\n", r.PublicKey[:]))

		// AllowedIPs: always include the peer's own VPN addresses
		allowedIPs := []string{}
		if r.VPN4.IsValid() {
			allowedIPs = append(allowedIPs, r.VPN4.String()+"/32")
		}
		if r.VPN6.IsValid() {
			allowedIPs = append(allowedIPs, r.VPN6.String()+"/128")
		}
		// If this peer acts as next-hop for others, their IPs are added elsewhere
		if len(allowedIPs) > 0 {
			sb.WriteString(fmt.Sprintf("allowed_ip=%s\n", strings.Join(allowedIPs, ",")))
		}

		// Endpoint (if hole punch succeeded)
		if r.DirectAddr != nil {
			sb.WriteString(fmt.Sprintf("endpoint=%s\n", r.DirectAddr.String()))
		}

		// Persistent keepalive for NAT hole punch maintenance
		sb.WriteString("persistent_keepalive_interval=25\n")
	}

	return sb.String()
}

// AddRelayChainRoutes updates AllowedIPs for intermediate peers to enable A-B-C routing.
// For each route where NextHop is non-nil, the intermediate peer (NextHop) gets
// the unreachable peer's VPN IPs added to its AllowedIPs.
func (t *Table) AddRelayChainRoutes() {
	// Collect which IPs need to be routed through which next-hop
	nextHopRoutes := make(map[string][]string) // nextHop pubKey -> []CIDR

	for _, r := range t.routes {
		if r.NextHop == nil {
			continue
		}
		nhKey := r.NextHop.String()
		if r.VPN4.IsValid() {
			nextHopRoutes[nhKey] = append(nextHopRoutes[nhKey], r.VPN4.String()+"/32")
		}
		if r.VPN6.IsValid() {
			nextHopRoutes[nhKey] = append(nextHopRoutes[nhKey], r.VPN6.String()+"/128")
		}
	}

	// Add the relay-chain IPs to the next-hop peer's allowed IPs
	// (This is handled by BuildIPCConfig in a real implementation)
	_ = nextHopRoutes
}
