// Package ipc defines the gRPC service interface for daemon<->UI communication.
// The daemon listens on a Unix domain socket; UI clients connect to it.
package ipc

// DaemonStatus represents the current VPN connection state.
type DaemonStatus struct {
	Running     bool   `json:"running"`
	VPNActive   bool   `json:"vpn_active"`
	IP4         string `json:"ip4"`
	IP6         string `json:"ip6"`
	RoomID      string `json:"room_id,omitempty"`
	PeerCount   int    `json:"peer_count"`
	RelayUsed   bool   `json:"relay_used"` // true if currently relaying via DERP
	RelayURL    string `json:"relay_url"`
	PathSummary string `json:"path_summary"` // inactive, no-peers, waiting, direct, derp, next-hop, degraded
}

// ConnectedPeer represents a connected VPN peer.
type ConnectedPeer struct {
	PublicKey    string  `json:"public_key"`
	Name         string  `json:"name"`
	IP4          string  `json:"ip4"`
	IP6          string  `json:"ip6"`
	Direct       bool    `json:"direct"` // true if P2P, false if DERP relay
	Path         string  `json:"path"`   // waiting, direct, derp, next-hop, configured, unresolved
	Endpoint     string  `json:"endpoint,omitempty"`
	RelayURL     string  `json:"relay_url,omitempty"`
	NextHop      string  `json:"next_hop,omitempty"`
	LatencyMs    float64 `json:"latency_ms"`
	LastSeenSecs int64   `json:"last_seen_secs"`
	LastError    string  `json:"last_error,omitempty"`
}

// Command types sent from UI to daemon via IPC.
const (
	CmdConnect    = "connect"
	CmdDisconnect = "disconnect"
	CmdStatus     = "status"
	CmdListPeers  = "list_peers"
	CmdEnterRoom  = "enter_room"
	CmdLeaveRoom  = "leave_room"
	CmdPing       = "ping"
)

// IPCRequest is the JSON format for IPC commands.
type IPCRequest struct {
	Cmd    string            `json:"cmd"`
	Params map[string]string `json:"params,omitempty"`
}

// IPCResponse is the JSON format for IPC responses.
type IPCResponse struct {
	OK    bool        `json:"ok"`
	Error string      `json:"error,omitempty"`
	Data  interface{} `json:"data,omitempty"`
}
