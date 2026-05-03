// Package routing manages WireGuard peer configuration and relay chain routing.
// Receives topology updates from the control plane and configures AllowedIPs
// to enable A-B-C relay chains where B routes traffic between A and C.
package routing

import (
	"fmt"
	"net/netip"
	"strings"
	"sync"

	"github.com/ourcord/ourcord/daemon/pkg/derp"
	"github.com/ourcord/ourcord/daemon/pkg/ice"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// PeerRoute describes how to reach a remote VPN peer.
type PeerRoute struct {
	PublicKey   wgtypes.Key
	ID          string
	Name        string
	VPN4        netip.Addr      // peer's VPN IPv4
	VPN6        netip.Addr      // peer's VPN IPv6
	NextHop     *wgtypes.Key    // nil = direct, non-nil = route via this intermediate peer
	DirectAddr  *netip.AddrPort // UDP endpoint if hole-punch succeeded
	ICEReady    bool            // true when the daemon has an ICE Conn for this peer
	DERPURL     string          // DERP relay URL (fallback)
	DERPNodeKey string          // peer DERP node key (nodekey:...)
	LastSeen    int64
	LastError   string
}

// Table holds the routing table for all VPN peers.
//
// Concurrency: once G-B's connect pipeline lands, the mesh poller will Upsert
// routes from one goroutine while the signal callback Removes/Upserts from
// another. RWMutex guards the map; readers (BuildIPCConfig, All) take RLock,
// mutators take Lock.
type Table struct {
	mu sync.RWMutex
	// listenPort is the wg UDP port written as `listen_port=` in the UAPI
	// config. 0 = let wireguard-go pick an ephemeral port (Phase-1 default
	// when STUN/ICE will discover the reflexive address). Tests / smoke
	// runbooks pin a known port via SetListenPort to enable manual endpoint
	// hints before per-peer ICE lands.
	listenPort uint16
	routes     map[string]*PeerRoute // publicKey (hex) -> route
}

// NewTable creates an empty routing table.
func NewTable() *Table {
	return &Table{routes: make(map[string]*PeerRoute)}
}

// Upsert adds or updates a route.
func (t *Table) Upsert(r *PeerRoute) {
	t.mu.Lock()
	t.routes[r.PublicKey.String()] = r
	t.mu.Unlock()
}

// Remove deletes a route.
func (t *Table) Remove(publicKey wgtypes.Key) {
	t.mu.Lock()
	delete(t.routes, publicKey.String())
	t.mu.Unlock()
}

// Replace swaps the full peer route set while preserving table-level settings
// such as listenPort. The control plane is the source of truth for the current
// mesh scope, so peers removed from a room/user config must disappear instead
// of lingering from a previous fetch.
func (t *Table) Replace(routes []*PeerRoute) {
	t.mu.Lock()
	next := make(map[string]*PeerRoute, len(routes))
	for _, r := range routes {
		if r == nil {
			continue
		}
		if old := t.routes[r.PublicKey.String()]; old != nil {
			r.ICEReady = old.ICEReady
			if r.DirectAddr == nil && old.DirectAddr != nil {
				ap := *old.DirectAddr
				r.DirectAddr = &ap
			}
		}
		next[r.PublicKey.String()] = r
	}
	t.routes = next
	t.mu.Unlock()
}

// SetICEReady marks a peer as having a live ICE transport.
func (t *Table) SetICEReady(publicKey wgtypes.Key, ready bool) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.routes[publicKey.String()]
	if r == nil || r.ICEReady == ready {
		return false
	}
	r.ICEReady = ready
	return true
}

// All returns a snapshot of all routes.
func (t *Table) All() []*PeerRoute {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make([]*PeerRoute, 0, len(t.routes))
	for _, r := range t.routes {
		cp := *r
		if r.NextHop != nil {
			nh := *r.NextHop
			cp.NextHop = &nh
		}
		if r.DirectAddr != nil {
			ap := *r.DirectAddr
			cp.DirectAddr = &ap
		}
		out = append(out, &cp)
	}
	return out
}

// SetListenPort pins the WireGuard UDP listen port written into BuildIPCConfig.
// Pass 0 to revert to ephemeral.
func (t *Table) SetListenPort(p uint16) {
	t.mu.Lock()
	t.listenPort = p
	t.mu.Unlock()
}

// BuildIPCConfig generates the WireGuard IPC peer configuration for all routes.
// This string is passed to device.IpcSet().
//
// AllowedIPs include each peer's own VPN addresses and, when this peer is the
// next hop for an A-B-C relay chain, the CIDRs of the peers it must forward
// to. Pass the result of AddRelayChainRoutes to wire those in.
func (t *Table) BuildIPCConfig(privateKey wgtypes.Key) string {
	chainExtra := t.AddRelayChainRoutes()

	t.mu.RLock()
	defer t.mu.RUnlock()

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("private_key=%x\n", privateKey[:]))
	if t.listenPort != 0 {
		sb.WriteString(fmt.Sprintf("listen_port=%d\n", t.listenPort))
	}

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
		// WireGuard UAPI requires one allowed_ip per line; comma-joined values
		// are silently rejected, so emit each CIDR individually.
		for _, cidr := range allowedIPs {
			sb.WriteString("allowed_ip=")
			sb.WriteString(cidr)
			sb.WriteString("\n")
		}

		// Endpoint: only set for direct/DERP or next-hop targets, not for the
		// "virtual" remote peer we reach via someone else. DERP is preferred
		// as the baseline path; once ICE succeeds, ICEReady takes precedence
		// and moves the same peer onto the direct bind without changing
		// AllowedIPs.
		if r.NextHop == nil && r.ICEReady {
			if ep, err := ice.EndpointString(r.PublicKey.String()); err == nil {
				sb.WriteString(fmt.Sprintf("endpoint=%s\n", ep))
			}
		} else if r.NextHop == nil && r.DERPURL != "" && r.DERPNodeKey != "" {
			if ep, err := derp.EndpointString(r.DERPURL, r.DERPNodeKey); err == nil {
				sb.WriteString(fmt.Sprintf("endpoint=%s\n", ep))
			}
		} else if r.NextHop == nil && r.DirectAddr != nil {
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
	t.mu.RLock()
	defer t.mu.RUnlock()
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
