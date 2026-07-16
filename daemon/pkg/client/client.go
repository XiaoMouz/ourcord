// Package client is the UI-agnostic client core for driving a running ourcordd
// over its local IPC socket. It exposes typed operations (Status, ListPeers,
// Connect, EnterNetwork, …) that return data and errors — no flag parsing, no
// stdout/stderr, no os.Exit. A CLI, a TUI, or a native GUI can share this one
// implementation instead of each re-deriving the transport, parameter shapes,
// and response decoding. Keep this package free of any presentation concern so
// the interaction layer stays swappable.
//
// The wire transport is gRPC (proto/ourcord/v1) over an authenticated unix
// socket: the W3 HMAC handshake completes on the raw conn before HTTP/2
// starts. Presenters never see any of this — the API below is unchanged from
// the JSON-transport era.
package client

import (
	"context"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	ourcordv1 "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
)

// Client is a typed wrapper over the daemon's gRPC IPC surface.
type Client struct {
	conn  *grpc.ClientConn // nil when constructed via New (test seam)
	svc   ourcordv1.DaemonServiceClient
	diag  ourcordv1.DaemonDiagnosticsServiceClient
	voice ourcordv1.DaemonVoiceServiceClient
}

// Dial connects to the daemon at socketPath using the shared IPC HMAC key
// (loaded from the default path; nil when unavailable, matching the daemon's
// graceful-rollout behavior). It fails fast when the daemon is not listening.
// The caller owns Close.
func Dial(socketPath string) (*Client, error) {
	secret := loadHMACKey()
	// Probe eagerly: grpc.NewClient is lazy and would defer "daemon not
	// running" to the first RPC, which makes for worse presenter UX.
	probe, err := ipc.DialAuthenticated(context.Background(), socketPath, secret)
	if err != nil {
		return nil, err
	}
	_ = probe.Close()

	conn, err := grpc.NewClient(
		"passthrough:///ourcordd",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return ipc.DialAuthenticated(ctx, socketPath, secret)
		}),
	)
	if err != nil {
		return nil, err
	}
	return &Client{
		conn:  conn,
		svc:   ourcordv1.NewDaemonServiceClient(conn),
		diag:  ourcordv1.NewDaemonDiagnosticsServiceClient(conn),
		voice: ourcordv1.NewDaemonVoiceServiceClient(conn),
	}, nil
}

// New wraps an existing gRPC connection (e.g. a bufconn in tests).
func New(conn grpc.ClientConnInterface) *Client {
	return &Client{
		svc:   ourcordv1.NewDaemonServiceClient(conn),
		diag:  ourcordv1.NewDaemonDiagnosticsServiceClient(conn),
		voice: ourcordv1.NewDaemonVoiceServiceClient(conn),
	}
}

// Close releases the underlying connection.
func (c *Client) Close() error {
	if c.conn != nil {
		return c.conn.Close()
	}
	return nil
}

func loadHMACKey() []byte {
	key, err := ipc.LoadOrCreateHMACKey(ipc.DefaultHMACKeyPath())
	if err != nil {
		return nil
	}
	return key
}

// DaemonError is returned when the daemon accepts the request but rejects the
// operation (OperationResult.ok == false, or an application-level RPC status).
// Transport failures are returned as the underlying error instead.
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

// opErr folds an OperationResult + transport error into the client's error
// contract: transport error as-is, ok=false as *DaemonError, else nil.
func opErr(cmd string, res *ourcordv1.OperationResult, err error) error {
	if err != nil {
		return rpcErr(cmd, err)
	}
	if res == nil || !res.GetOk() {
		return &DaemonError{Cmd: cmd, Msg: res.GetErrorMessage()}
	}
	return nil
}

// rpcErr converts an application-level gRPC status error (the codes our
// daemon adapters emit) into a DaemonError so presenters show the daemon's
// words. Transport-level failures (Unavailable, DeadlineExceeded, …) pass
// through unchanged — they are not daemon rejections.
func rpcErr(cmd string, err error) error {
	if st, ok := status.FromError(err); ok && st.Message() != "" &&
		(st.Code() == codes.Internal || st.Code() == codes.Unknown) {
		return &DaemonError{Cmd: cmd, Msg: st.Message()}
	}
	return err
}

// Status returns the daemon's current VPN status.
func (c *Client) Status() (ipc.DaemonStatus, error) {
	resp, err := c.svc.GetStatus(context.Background(), &ourcordv1.GetStatusRequest{})
	if err != nil {
		return ipc.DaemonStatus{}, rpcErr("status", err)
	}
	return ipc.StatusFromProto(resp.GetStatus()), nil
}

// ListPeers returns the daemon's current connected-peer list.
func (c *Client) ListPeers() ([]ipc.ConnectedPeer, error) {
	resp, err := c.svc.ListPeers(context.Background(), &ourcordv1.ListPeersRequest{})
	if err != nil {
		return nil, rpcErr("peers", err)
	}
	return ipc.PeersFromProto(resp.GetPeers()), nil
}

// Connect brings the VPN up.
func (c *Client) Connect() error {
	resp, err := c.svc.Connect(context.Background(), &ourcordv1.ConnectRequest{})
	return opErr("connect", resp.GetResult(), err)
}

// Disconnect tears the VPN down.
func (c *Client) Disconnect() error {
	resp, err := c.svc.Disconnect(context.Background(), &ourcordv1.DisconnectRequest{})
	return opErr("disconnect", resp.GetResult(), err)
}

// EnterNetwork joins a network by its room vpn_namespace or a pair:<a>.<b> id.
func (c *Client) EnterNetwork(networkID string) error {
	resp, err := c.svc.EnterNetwork(context.Background(), &ourcordv1.EnterNetworkRequest{NetworkId: networkID})
	return opErr("enter-network", resp.GetResult(), err)
}

// LeaveNetwork leaves the current network.
func (c *Client) LeaveNetwork() error {
	resp, err := c.svc.LeaveNetwork(context.Background(), &ourcordv1.LeaveNetworkRequest{})
	return opErr("leave-network", resp.GetResult(), err)
}

// EnterRoom is the legacy room-id alias for EnterNetwork. The daemon resolves
// both identifiers through the same path; prefer EnterNetwork with the room's
// vpn_namespace.
func (c *Client) EnterRoom(roomID string) error { return c.EnterNetwork(roomID) }

// LeaveRoom is the legacy alias for LeaveNetwork.
func (c *Client) LeaveRoom() error { return c.LeaveNetwork() }

// ForceDERP is a diagnostic that forces a peer onto the DERP relay path.
func (c *Client) ForceDERP(peerPublicKey, reason string) error {
	if reason == "" {
		reason = "diagnostic-force-derp"
	}
	resp, err := c.diag.ForceDERP(context.Background(), &ourcordv1.ForceDERPRequest{
		PeerPublicKey: peerPublicKey,
		Reason:        reason,
	})
	return opErr("force-derp", resp.GetResult(), err)
}

// Ping checks daemon liveness.
func (c *Client) Ping() error {
	_, err := c.diag.Ping(context.Background(), &ourcordv1.PingRequest{})
	if err != nil {
		return rpcErr("ping", err)
	}
	return nil
}

// VoiceJoin starts the voice session for the current network.
func (c *Client) VoiceJoin() error {
	resp, err := c.voice.VoiceJoin(context.Background(), &ourcordv1.VoiceJoinRequest{})
	return opErr("voice-join", resp.GetResult(), err)
}

// VoiceLeave ends the voice session.
func (c *Client) VoiceLeave() error {
	resp, err := c.voice.VoiceLeave(context.Background(), &ourcordv1.VoiceLeaveRequest{})
	return opErr("voice-leave", resp.GetResult(), err)
}

// SetVoiceMute mutes/unmutes the local microphone.
func (c *Client) SetVoiceMute(muted bool) error {
	resp, err := c.voice.SetMute(context.Background(), &ourcordv1.SetMuteRequest{Muted: muted})
	return opErr("voice-mute", resp.GetResult(), err)
}

// SetVoiceDeafen deafens/undeafens local playback.
func (c *Client) SetVoiceDeafen(deafened bool) error {
	resp, err := c.voice.SetDeafen(context.Background(), &ourcordv1.SetDeafenRequest{Deafened: deafened})
	return opErr("voice-deafen", resp.GetResult(), err)
}

// VoiceStatus returns the current voice session snapshot.
func (c *Client) VoiceStatus() (ipc.VoiceStatus, error) {
	resp, err := c.voice.GetVoiceStatus(context.Background(), &ourcordv1.GetVoiceStatusRequest{})
	if err != nil {
		return ipc.VoiceStatus{}, rpcErr("voice-status", err)
	}
	return ipc.VoiceStatusFromProto(resp.GetStatus()), nil
}

// ListAudioDevices enumerates local capture and playback devices. It returns a
// DaemonError when the daemon was built without the voice tag (no audio backend).
func (c *Client) ListAudioDevices() (capture, playback []ipc.AudioDevice, err error) {
	resp, err := c.voice.ListAudioDevices(context.Background(), &ourcordv1.ListAudioDevicesRequest{})
	if err != nil {
		return nil, nil, rpcErr("voice-devices", err)
	}
	if res := resp.GetResult(); res == nil || !res.GetOk() {
		return nil, nil, &DaemonError{Cmd: "voice-devices", Msg: res.GetErrorMessage()}
	}
	return ipc.AudioDevicesFromProto(resp.GetCapture()), ipc.AudioDevicesFromProto(resp.GetPlayback()), nil
}

// SetAudioDevices selects the capture and playback device IDs (empty = system
// default). Applies immediately if a call is active, else on the next join.
func (c *Client) SetAudioDevices(captureID, playbackID string) error {
	resp, err := c.voice.SetAudioDevices(context.Background(), &ourcordv1.SetAudioDevicesRequest{
		CaptureId:  captureID,
		PlaybackId: playbackID,
	})
	return opErr("voice-set-devices", resp.GetResult(), err)
}
