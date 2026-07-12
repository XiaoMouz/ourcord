// Package ipc provides the daemon<->UI IPC layer: the authenticated unix-socket
// transport the gRPC server/clients run over (transport.go, auth.go), the
// daemon-side domain types (DaemonStatus, ConnectedPeer), and the conversions
// between those and the wire types generated from proto/ourcord/v1
// (conv.go). The proto contract is the field source of truth; the JSON structs
// here are what the daemon core produces and what pkg/client returns to
// presenters.
package ipc

// DaemonStatus is the JSON compatibility shape for ourcord.v1.DaemonStatus.
type DaemonStatus struct {
	Running        bool           `json:"running"`
	VPNActive      bool           `json:"vpn_active"`
	IP4            string         `json:"ip4"`
	IP6            string         `json:"ip6"`
	NetworkID      string         `json:"network_id,omitempty"`
	RoomID         string         `json:"room_id,omitempty"`
	PeerCount      int            `json:"peer_count"`
	RelayUsed      bool           `json:"relay_used"` // true if currently relaying via DERP
	RelayURL       string         `json:"relay_url"`
	PathSummary    string         `json:"path_summary"`     // inactive, no-peers, waiting, direct, derp, next-hop, degraded
	PathFlapsTotal uint64         `json:"path_flaps_total"` // Σ per-peer path transitions this connection
	Transport      TransportStats `json:"transport"`
}

type TransportStats struct {
	MTU                   int    `json:"mtu"`
	ICESentPackets        uint64 `json:"ice_sent_packets"`
	ICERecvPackets        uint64 `json:"ice_recv_packets"`
	ICERecvDrops          uint64 `json:"ice_recv_drops"`
	ICESendErrors         uint64 `json:"ice_send_errors"`
	ICERecvErrors         uint64 `json:"ice_recv_errors"`
	ICEProbeSent          uint64 `json:"ice_probe_sent"`
	ICEProbeAckSent       uint64 `json:"ice_probe_ack_sent"`
	ICEProbeAckReceived   uint64 `json:"ice_probe_ack_received"`
	ICEProbeTimeouts      uint64 `json:"ice_probe_timeouts"`
	ICEProbeInvalid       uint64 `json:"ice_probe_invalid"`
	ICEMaxPacketBytes     uint64 `json:"ice_max_packet_bytes"`
	DERPSentPackets       uint64 `json:"derp_sent_packets"`
	DERPRecvPackets       uint64 `json:"derp_recv_packets"`
	DERPRecvDrops         uint64 `json:"derp_recv_drops"`
	DERPSuppressedPackets uint64 `json:"derp_suppressed_packets"`
	DERPSendErrors        uint64 `json:"derp_send_errors"`
	DERPRecvErrors        uint64 `json:"derp_recv_errors"`
	DERPMaxPacketBytes    uint64 `json:"derp_max_packet_bytes"`
}

// ConnectedPeer is the JSON compatibility shape for ourcord.v1.ConnectedPeer.
type ConnectedPeer struct {
	PublicKey         string  `json:"public_key"`
	Name              string  `json:"name"`
	IP4               string  `json:"ip4"`
	IP6               string  `json:"ip6"`
	Direct            bool    `json:"direct"` // true if P2P, false if DERP relay
	Path              string  `json:"path"`   // waiting, direct, derp, next-hop, unresolved
	Endpoint          string  `json:"endpoint,omitempty"`
	CandidateEndpoint string  `json:"candidate_endpoint,omitempty"`
	RelayURL          string  `json:"relay_url,omitempty"`
	NextHop           string  `json:"next_hop,omitempty"`
	LatencyMs         float64 `json:"latency_ms"`
	LastSeenSecs      int64   `json:"last_seen_secs"`
	LastError         string  `json:"last_error,omitempty"`
	PathTransitions   uint64  `json:"path_transitions"`   // times this peer's path label changed
	PathDwellSecs     int64   `json:"path_dwell_secs"`    // seconds held in the current path
	Flapping          bool    `json:"flapping,omitempty"` // path unstable (≥ threshold changes in window)
}

// Command names key the daemon's internal HandleIPC mux; the gRPC service
// adapters translate the proto RPCs onto these. They are no longer a wire
// format.
const (
	CmdConnect      = "connect"
	CmdDisconnect   = "disconnect"
	CmdStatus       = "status"
	CmdListPeers    = "list_peers"
	CmdEnterRoom    = "enter_room"
	CmdLeaveRoom    = "leave_room"
	CmdEnterNetwork = "enter_network"
	CmdLeaveNetwork = "leave_network"
	CmdForceDERP    = "force_derp"
	CmdPing         = "ping"
)

// IPCRequest is the daemon's internal command envelope (HandleIPC mux input).
type IPCRequest struct {
	Cmd    string            `json:"cmd"`
	Params map[string]string `json:"params,omitempty"`
}

// IPCResponse is the daemon's internal command result (HandleIPC mux output).
// Data holds concrete domain values (DaemonStatus, []ConnectedPeer) that the
// gRPC adapters convert to proto messages.
type IPCResponse struct {
	OK    bool        `json:"ok"`
	Error string      `json:"error,omitempty"`
	Data  interface{} `json:"data,omitempty"`
}
