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
//
// AllowedIPs include each peer's own VPN addresses and, when this peer is the
// next hop for an A-B-C relay chain, the CIDRs of the peers it must forward
// to. Pass the result of AddRelayChainRoutes to wire those in.
func (t *Table) BuildIPCConfig(privateKey wgtypes.Key) string {
	chainExtra := t.AddRelayChainRoutes()

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("private_key=%x\n", privateKey[:]))

	for _, r := range t.routes {
		sb.WriteString(fmt.Sprintf("public_key=%x\n", r.PublicKey[:]))

		// AllowedIPs: the peer's own VPN addresses plus any chain-routed CIDRs.
		allowedIPs := []string{}
		if r.VPN4.IsValid() {
			allowedIPs = append(allowedIPs, r.VPN4.String()+"/32")
		}
		if r.VPN6.IsValid() {
			allowedIPs = append(allowedIPs, r.VPN6.String()+"/128")
		}
		if extras, ok := chainExtra[r.PublicKey.String()]; ok {
			allowedIPs = append(allowedIPs, extras...)
		}
		if len(allowedIPs) > 0 {
			sb.WriteString(fmt.Sprintf("allowed_ip=%s\n", strings.Join(allowedIPs, ",")))
		}

		// Endpoint: only set for direct or next-hop targets, not for the
		// "virtual" remote peer we reach via someone else.
		if r.NextHop == nil && r.DirectAddr != nil {
			sb.WriteString(fmt.Sprintf("endpoint=%s\n", r.DirectAddr.String()))
		}

		// Persistent keepalive for NAT hole punch maintenance
		sb.WriteString("persistent_keepalive_interval=25\n")
	}

	return sb.String()
}

// AddRelayChainRoutes computes, for each peer that acts as a next hop in an
// A-B-C chain, the list of CIDRs it must forward (the unreachable peers'
// VPN IPs). The returned map is keyed by the next-hop peer's public key string.
//
// This used to be a side-effecting method that did nothing; it is now pure and
// consumed by BuildIPCConfig.
func (t *Table) AddRelayChainRoutes() map[string][]string {
	nextHopRoutes := make(map[string][]string)
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
	return nextHopRoutes
}
