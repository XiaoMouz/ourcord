// Package ice implements ICE-based hole punching for direct P2P connections.
// Supports both IPv4 NAT traversal and IPv6 direct connection attempts.
// Uses the pion/ice library for standards-compliant ICE.
package ice

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	pionice "github.com/pion/ice/v4"
)

// CandidateType mirrors pion ICE candidate types.
type CandidateType = pionice.CandidateType

// HolePunchResult is the outcome of a hole punching attempt.
type HolePunchResult struct {
	Success    bool
	LocalAddr  net.Addr
	RemoteAddr net.Addr
	RTTMs      float64 // round-trip time in milliseconds
	Method     string  // "direct-ipv6", "nat-ipv4", "derp-relay"
}

// Agent manages ICE for a single peer connection.
type Agent struct {
	agent      *pionice.Agent
	cancelFunc context.CancelFunc
}

// Config holds ICE agent configuration.
type Config struct {
	STUNServers []string // STUN server URLs (stun:host:port)
	// ExcludeInterfaces lists exact interface names (typically the daemon's own
	// TUN, e.g. "utun3") that must never contribute host candidates, on top of
	// the isVPNInterface prefix heuristic. Ground truth beats name guessing.
	ExcludeInterfaces []string
	// Called when gathering is complete; send these candidates to peer via signaling
	OnCandidates func(candidates []string)
}

// buildInterfaceFilter returns pion's keep-predicate: drop exact-named excluded
// interfaces (the daemon's real TUN) and anything matching the VPN/overlay
// prefix heuristic; keep underlay NICs.
func buildInterfaceFilter(exclude []string) func(string) bool {
	return func(name string) bool {
		for _, ex := range exclude {
			if ex != "" && name == ex {
				return false
			}
		}
		return !isVPNInterface(name)
	}
}

// NewAgent creates a new ICE agent for hole punching with a specific peer.
func NewAgent(cfg Config) (*Agent, error) {
	// Build STUN URL list
	urls := make([]*pionice.URL, 0, len(cfg.STUNServers))
	for _, s := range cfg.STUNServers {
		u, err := pionice.ParseURL(s)
		if err != nil {
			return nil, fmt.Errorf("parse STUN URL %q: %w", s, err)
		}
		urls = append(urls, u)
	}

	iceAgent, err := pionice.NewAgent(&pionice.AgentConfig{
		Urls: urls,
		// UDP only by default. pion/ice v4 requires explicit TCPMux/TCP4Listener
		// to actually use TCP candidates; advertising NetworkTypeTCP{4,6} without
		// configuring a TCP mux silently does nothing. If a future deployment
		// needs TCP fallback, set up a TCPMux on a bound listener and append
		// the TCP types here. For now, UDP IPv6 → UDP IPv4 → DERP relay covers
		// our bases.
		NetworkTypes: []pionice.NetworkType{
			pionice.NetworkTypeUDP4,
			pionice.NetworkTypeUDP6,
		},
		CandidateTypes: []pionice.CandidateType{
			pionice.CandidateTypeHost,
			pionice.CandidateTypeServerReflexive,
			pionice.CandidateTypePeerReflexive,
		},
		// Never gather host candidates on our own VPN/overlay TUN: ICE must
		// discover the underlay path between peers. Pairing with our own utun
		// address would loop WireGuard back through the tunnel (over DERP),
		// yielding a "direct" path that is actually circular — it passes the
		// probe but then loses liveness and flaps. Underlay NICs (eth0/en0) are
		// kept, so same-LAN RFC1918/ULA host candidates still work. The
		// daemon's actual TUN name arrives via cfg.ExcludeInterfaces so the
		// exclusion is grounded in fact, not just the name-prefix heuristic.
		InterfaceFilter: buildInterfaceFilter(cfg.ExcludeInterfaces),
		// Prefer IPv6 host candidates
		InsecureSkipVerify: false,
	})
	if err != nil {
		return nil, fmt.Errorf("create ICE agent: %w", err)
	}

	a := &Agent{agent: iceAgent}

	// Gather candidates and collect them. pion fires OnCandidate from its
	// internal gather goroutine, and the nil-candidate sentinel signals end
	// of gathering. Two concerns are addressed below:
	//   1. (H13) The user callback is dispatched on a fresh goroutine so a
	//      slow signaling-WS write doesn't stall pion's gather loop and
	//      delay subsequent candidate enumeration.
	//   2. The candidate slice is mutated from the gather goroutine and
	//      read again at sentinel time; a mutex guards the snapshot.
	var (
		mu       sync.Mutex
		gathered []string
	)
	if err := iceAgent.OnCandidate(func(c pionice.Candidate) {
		if c == nil {
			mu.Lock()
			snapshot := make([]string, len(gathered))
			copy(snapshot, gathered)
			mu.Unlock()
			if cfg.OnCandidates != nil {
				go cfg.OnCandidates(snapshot)
			}
			return
		}
		mu.Lock()
		gathered = append(gathered, c.Marshal())
		mu.Unlock()
	}); err != nil {
		return nil, fmt.Errorf("set candidate handler: %w", err)
	}

	return a, nil
}

// isVPNInterface reports whether an interface name belongs to a local VPN /
// overlay tunnel that ICE must not gather candidates on. Covers our own TUN
// ("utun" on Linux, "utunN" on macOS, or an "ourcord"-named device).
func isVPNInterface(name string) bool {
	for _, prefix := range []string{"utun", "ourcord"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// GatherCandidates starts candidate gathering. Candidates are delivered via OnCandidates callback.
func (a *Agent) GatherCandidates() error {
	return a.agent.GatherCandidates()
}

// AddRemoteCandidate adds a remote ICE candidate received via signaling.
//
// J7: reject candidates whose advertised address is loopback or link-local.
// A malicious peer could otherwise enumerate `127.0.0.1` / `169.254.x.x`
// candidates and trick our local STUN check into probing host services or
// link-local devices on our behalf. RFC1918 / ULA ranges remain accepted
// because same-LAN P2P is a normal mode for OurCord (5–10 person groups
// with at least two members on the same office/home network).
func (a *Agent) AddRemoteCandidate(candidateStr string) error {
	c, err := pionice.UnmarshalCandidate(candidateStr)
	if err != nil {
		return fmt.Errorf("unmarshal candidate: %w", err)
	}
	if ip := net.ParseIP(c.Address()); ip != nil {
		if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
			return fmt.Errorf("ice: rejecting unsafe remote candidate address %s", c.Address())
		}
	}
	return a.agent.AddRemoteCandidate(c)
}

// Dial performs the ICE connection handshake as the controlling agent.
// Returns a Conn on success that wraps the ICE transport.
func (a *Agent) Dial(ctx context.Context, ufrag, pwd string) (*pionice.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return a.agent.Dial(ctx, ufrag, pwd)
}

// Accept performs the ICE connection handshake as the controlled agent.
func (a *Agent) Accept(ctx context.Context, ufrag, pwd string) (*pionice.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return a.agent.Accept(ctx, ufrag, pwd)
}

// Credentials returns the local ICE ufrag and password.
func (a *Agent) Credentials() (ufrag, pwd string, err error) {
	return a.agent.GetLocalUserCredentials()
}

// Close tears down the ICE agent.
func (a *Agent) Close() error {
	return a.agent.Close()
}

// ParseSTUNURLs converts a list of host:port strings into stun: URLs.
func ParseSTUNURLs(servers []string) []string {
	result := make([]string, 0, len(servers))
	for _, s := range servers {
		if strings.HasPrefix(s, "stun:") {
			result = append(result, s)
		} else {
			result = append(result, "stun:"+s)
		}
	}
	return result
}
