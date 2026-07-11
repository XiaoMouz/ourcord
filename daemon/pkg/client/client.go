// Package client is the UI-agnostic client core for driving a running ourcordd
// over its local IPC socket. It exposes typed operations (Status, ListPeers,
// Connect, EnterNetwork, …) that return data and errors — no flag parsing, no
// stdout/stderr, no os.Exit. A CLI, a TUI, or a native GUI can share this one
// implementation instead of each re-deriving the IPC command names, parameter
// shapes, and response decoding. Keep this package free of any presentation
// concern so the interaction layer stays swappable.
package client

import (
	"encoding/json"
	"fmt"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

// Client is a typed wrapper over an ipc.Client connection to the daemon.
type Client struct {
	ipc *ipc.Client
}

// Dial connects to the daemon at socketPath using the shared IPC HMAC key
// (loaded from the default path; nil when unavailable, matching the daemon's
// graceful-rollout behavior). The caller owns Close.
func Dial(socketPath string) (*Client, error) {
	ic, err := ipc.NewClientWithSecret(socketPath, loadHMACKey())
	if err != nil {
		return nil, err
	}
	return &Client{ipc: ic}, nil
}

// New wraps an already-connected ipc.Client. Primarily a test seam.
func New(ipcClient *ipc.Client) *Client { return &Client{ipc: ipcClient} }

// Close releases the underlying IPC connection.
func (c *Client) Close() error { return c.ipc.Close() }

func loadHMACKey() []byte {
	key, err := ipc.LoadOrCreateHMACKey(ipc.DefaultHMACKeyPath())
	if err != nil {
		return nil
	}
	return key
}

// DaemonError is returned when the daemon accepts the request but rejects the
// operation (IPCResponse.OK == false). Transport failures are returned as the
// underlying error instead.
type DaemonError struct {
	Cmd string
	Msg string
}

func (e *DaemonError) Error() string {
	if e.Msg == "" {
		return "daemon rejected " + e.Cmd
	}
	return e.Msg
}

// call runs an IPC command and converts a daemon-side rejection into an error.
func (c *Client) call(cmd string, params map[string]string) (ipc.IPCResponse, error) {
	resp, err := c.ipc.Call(cmd, params)
	if err != nil {
		return resp, err
	}
	if !resp.OK {
		return resp, &DaemonError{Cmd: cmd, Msg: resp.Error}
	}
	return resp, nil
}

// decode re-marshals a generic IPC payload (a map on the wire) into a concrete
// type, so callers get typed structs instead of interface{}.
func decode[T any](data interface{}) (T, error) {
	var out T
	b, err := json.Marshal(data)
	if err != nil {
		return out, fmt.Errorf("encode ipc payload: %w", err)
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return out, fmt.Errorf("decode ipc payload: %w", err)
	}
	return out, nil
}

// Status returns the daemon's current VPN status.
func (c *Client) Status() (ipc.DaemonStatus, error) {
	resp, err := c.call(ipc.CmdStatus, nil)
	if err != nil {
		return ipc.DaemonStatus{}, err
	}
	return decode[ipc.DaemonStatus](resp.Data)
}

// ListPeers returns the daemon's current connected-peer list.
func (c *Client) ListPeers() ([]ipc.ConnectedPeer, error) {
	resp, err := c.call(ipc.CmdListPeers, nil)
	if err != nil {
		return nil, err
	}
	return decode[[]ipc.ConnectedPeer](resp.Data)
}

// Connect brings the VPN up.
func (c *Client) Connect() error { _, err := c.call(ipc.CmdConnect, nil); return err }

// Disconnect tears the VPN down.
func (c *Client) Disconnect() error { _, err := c.call(ipc.CmdDisconnect, nil); return err }

// EnterNetwork joins a network by its room vpn_namespace or a pair:<a>.<b> id.
func (c *Client) EnterNetwork(networkID string) error {
	_, err := c.call(ipc.CmdEnterNetwork, map[string]string{"network_id": networkID})
	return err
}

// LeaveNetwork leaves the current network.
func (c *Client) LeaveNetwork() error { _, err := c.call(ipc.CmdLeaveNetwork, nil); return err }

// EnterRoom is the legacy room-id alias for EnterNetwork.
func (c *Client) EnterRoom(roomID string) error {
	_, err := c.call(ipc.CmdEnterRoom, map[string]string{"room_id": roomID})
	return err
}

// LeaveRoom is the legacy alias for LeaveNetwork.
func (c *Client) LeaveRoom() error { _, err := c.call(ipc.CmdLeaveRoom, nil); return err }

// ForceDERP is a diagnostic that forces a peer onto the DERP relay path.
func (c *Client) ForceDERP(peerPublicKey, reason string) error {
	if reason == "" {
		reason = "diagnostic-force-derp"
	}
	_, err := c.call(ipc.CmdForceDERP, map[string]string{"public_key": peerPublicKey, "reason": reason})
	return err
}

// Ping checks daemon liveness.
func (c *Client) Ping() error { _, err := c.call(ipc.CmdPing, nil); return err }
