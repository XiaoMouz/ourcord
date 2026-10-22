package client

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	ourcordv1 "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
)

// stubServer implements the gRPC services with canned typed payloads, so the
// client's conversion paths are exercised against the real gRPC transport.
type stubServer struct {
	ourcordv1.UnimplementedDaemonServiceServer
	ourcordv1.UnimplementedDaemonDiagnosticsServiceServer
	ourcordv1.UnimplementedDaemonVoiceServiceServer
}

func (stubServer) VoiceJoin(context.Context, *ourcordv1.VoiceJoinRequest) (*ourcordv1.VoiceJoinResponse, error) {
	return &ourcordv1.VoiceJoinResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) SetMute(context.Context, *ourcordv1.SetMuteRequest) (*ourcordv1.SetMuteResponse, error) {
	return &ourcordv1.SetMuteResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) GetVoiceStatus(context.Context, *ourcordv1.GetVoiceStatusRequest) (*ourcordv1.GetVoiceStatusResponse, error) {
	return &ourcordv1.GetVoiceStatusResponse{Status: &ourcordv1.VoiceStatus{
		Joined: true, Codec: "pcm", NetworkId: "lobby-x-voice",
		Participants: []*ourcordv1.VoiceParticipant{{PublicKey: "pk", Speaking: true, PacketsRx: 9, Secure: true}},
	}}, nil
}

func (stubServer) ListAudioDevices(context.Context, *ourcordv1.ListAudioDevicesRequest) (*ourcordv1.ListAudioDevicesResponse, error) {
	return &ourcordv1.ListAudioDevicesResponse{
		Result:   &ourcordv1.OperationResult{Ok: true},
		Capture:  []*ourcordv1.AudioDevice{{Id: "mic-1", Name: "Built-in Mic", IsDefault: true}},
		Playback: []*ourcordv1.AudioDevice{{Id: "spk-1", Name: "Speakers"}},
	}, nil
}

func (stubServer) SetAudioDevices(_ context.Context, req *ourcordv1.SetAudioDevicesRequest) (*ourcordv1.SetAudioDevicesResponse, error) {
	if req.GetCaptureId() == "bad" {
		return &ourcordv1.SetAudioDevicesResponse{Result: &ourcordv1.OperationResult{Ok: false, ErrorMessage: "no such device"}}, nil
	}
	return &ourcordv1.SetAudioDevicesResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) GetStatus(context.Context, *ourcordv1.GetStatusRequest) (*ourcordv1.GetStatusResponse, error) {
	return &ourcordv1.GetStatusResponse{Status: &ourcordv1.DaemonStatus{
		Running: true, VpnActive: true, Ipv4: "198.18.0.2", PeerCount: 1,
		PathSummary: ourcordv1.Path_PATH_DIRECT, NetworkId: "lobby-x-voice",
	}}, nil
}

func (stubServer) ListPeers(context.Context, *ourcordv1.ListPeersRequest) (*ourcordv1.ListPeersResponse, error) {
	return &ourcordv1.ListPeersResponse{Peers: []*ourcordv1.ConnectedPeer{{
		PublicKey: "pk", Path: ourcordv1.Path_PATH_DIRECT, Direct: true, Flapping: true, PathTransitions: 3,
	}}}, nil
}

func (stubServer) Connect(context.Context, *ourcordv1.ConnectRequest) (*ourcordv1.ConnectResponse, error) {
	return &ourcordv1.ConnectResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) Disconnect(context.Context, *ourcordv1.DisconnectRequest) (*ourcordv1.DisconnectResponse, error) {
	return &ourcordv1.DisconnectResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) EnterNetwork(_ context.Context, req *ourcordv1.EnterNetworkRequest) (*ourcordv1.EnterNetworkResponse, error) {
	if req.GetNetworkId() == "" {
		return &ourcordv1.EnterNetworkResponse{Result: &ourcordv1.OperationResult{Ok: false, ErrorMessage: "network_id required"}}, nil
	}
	return &ourcordv1.EnterNetworkResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) LeaveNetwork(context.Context, *ourcordv1.LeaveNetworkRequest) (*ourcordv1.LeaveNetworkResponse, error) {
	return &ourcordv1.LeaveNetworkResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) RefreshSession(context.Context, *ourcordv1.RefreshSessionRequest) (*ourcordv1.RefreshSessionResponse, error) {
	return &ourcordv1.RefreshSessionResponse{AccessToken: "jwt", UserId: "user-1", ExpiresAt: 1234}, nil
}

func (stubServer) UnenrollDevice(context.Context, *ourcordv1.UnenrollDeviceRequest) (*ourcordv1.UnenrollDeviceResponse, error) {
	return &ourcordv1.UnenrollDeviceResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (stubServer) Ping(context.Context, *ourcordv1.PingRequest) (*ourcordv1.PingResponse, error) {
	return &ourcordv1.PingResponse{}, nil
}

func (stubServer) ForceDERP(context.Context, *ourcordv1.ForceDERPRequest) (*ourcordv1.ForceDERPResponse, error) {
	return &ourcordv1.ForceDERPResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

// dialStub serves stubServer over an in-memory bufconn and returns a Client.
func dialStub(t *testing.T) *Client {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	ourcordv1.RegisterDaemonServiceServer(srv, stubServer{})
	ourcordv1.RegisterDaemonDiagnosticsServiceServer(srv, stubServer{})
	ourcordv1.RegisterDaemonVoiceServiceServer(srv, stubServer{})
	go srv.Serve(lis)
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
	)
	if err != nil {
		t.Fatalf("bufconn client: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return New(conn)
}

func TestStatusDecodesTyped(t *testing.T) {
	st, err := dialStub(t).Status()
	if err != nil {
		t.Fatal(err)
	}
	if !st.VPNActive || st.IP4 != "198.18.0.2" || st.PathSummary != "direct" || st.PeerCount != 1 {
		t.Fatalf("unexpected status: %+v", st)
	}
	// RoomID legacy alias mirrors NetworkID (proto omits room_id by design).
	if st.RoomID != "lobby-x-voice" || st.NetworkID != "lobby-x-voice" {
		t.Fatalf("network/room id mismatch: %+v", st)
	}
}

func TestListPeersDecodesTyped(t *testing.T) {
	peers, err := dialStub(t).ListPeers()
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 1 || peers[0].Path != "direct" || !peers[0].Direct || !peers[0].Flapping || peers[0].PathTransitions != 3 {
		t.Fatalf("unexpected peers: %+v", peers)
	}
}

func TestMutatingSucceeds(t *testing.T) {
	c := dialStub(t)
	for _, op := range []func() error{
		c.Connect,
		func() error { return c.EnterNetwork("lobby-x-voice") },
		c.Ping,
		func() error { return c.ForceDERP("pk", "") },
		c.UnenrollLocalDevice,
		c.LeaveNetwork,
		c.Disconnect,
	} {
		if err := op(); err != nil {
			t.Fatalf("mutating op: %v", err)
		}
	}
}

func TestRefreshSession(t *testing.T) {
	session, err := dialStub(t).RefreshSession()
	if err != nil {
		t.Fatal(err)
	}
	if session.AccessToken != "jwt" || session.UserID != "user-1" || session.ExpiresAt != 1234 {
		t.Fatalf("unexpected session: %+v", session)
	}
}

func TestVoiceOpsAndStatus(t *testing.T) {
	c := dialStub(t)
	if err := c.VoiceJoin(); err != nil {
		t.Fatalf("voice join: %v", err)
	}
	if err := c.SetVoiceMute(true); err != nil {
		t.Fatalf("voice mute: %v", err)
	}
	st, err := c.VoiceStatus()
	if err != nil {
		t.Fatal(err)
	}
	if !st.Joined || st.Codec != "pcm" || len(st.Participants) != 1 ||
		!st.Participants[0].Speaking || !st.Participants[0].Secure || st.Participants[0].PacketsRx != 9 {
		t.Fatalf("unexpected voice status: %+v", st)
	}
}

func TestAudioDeviceListAndSelect(t *testing.T) {
	c := dialStub(t)
	capture, playback, err := c.ListAudioDevices()
	if err != nil {
		t.Fatal(err)
	}
	if len(capture) != 1 || capture[0].ID != "mic-1" || !capture[0].IsDefault ||
		len(playback) != 1 || playback[0].Name != "Speakers" {
		t.Fatalf("unexpected devices: cap=%+v play=%+v", capture, playback)
	}
	if err := c.SetAudioDevices("mic-1", "spk-1"); err != nil {
		t.Fatalf("set devices: %v", err)
	}
	// A daemon-side rejection surfaces as a DaemonError.
	err = c.SetAudioDevices("bad", "")
	var de *DaemonError
	if !errors.As(err, &de) || de.Msg != "no such device" {
		t.Fatalf("expected DaemonError, got %v", err)
	}
}

func TestDaemonRejectionSurfacesAsError(t *testing.T) {
	err := dialStub(t).EnterNetwork("")
	if err == nil {
		t.Fatal("expected an error for empty network_id")
	}
	var de *DaemonError
	if !errors.As(err, &de) || de.Msg != "network_id required" {
		t.Fatalf("expected DaemonError with daemon message, got %v", err)
	}
}

// TestDialAuthenticatedRoundTrip proves the real path: HMAC handshake on the
// raw unix socket, then gRPC on top — the exact production wiring.
func TestDialAuthenticatedRoundTrip(t *testing.T) {
	dir, err := os.MkdirTemp("", "oc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s")
	if runtime.GOOS == "windows" {
		sock = `\\.\pipe\ourcord-client-test-` + filepath.Base(dir)
	}
	secret, err := ipc.LoadOrCreateHMACKey(filepath.Join(dir, "ipc.key"))
	if err != nil {
		t.Fatal(err)
	}

	lis, err := ipc.ListenAuthenticated(sock, secret)
	if err != nil {
		t.Fatal(err)
	}
	srv := grpc.NewServer()
	ourcordv1.RegisterDaemonServiceServer(srv, stubServer{})
	ourcordv1.RegisterDaemonDiagnosticsServiceServer(srv, stubServer{})
	ourcordv1.RegisterDaemonVoiceServiceServer(srv, stubServer{})
	go srv.Serve(lis)
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient(
		"passthrough:///ourcordd",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return ipc.DialAuthenticated(ctx, sock, secret)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	c := New(conn)

	st, err := c.Status()
	if err != nil || !st.VPNActive {
		t.Fatalf("status over authenticated socket: %+v err=%v", st, err)
	}

	// A client with the wrong key is rejected: the server closes silently after
	// the invalid HMAC (the client does not wait for an ack), so the failure
	// surfaces on the first RPC rather than at dial time.
	wrong := make([]byte, ipc.HMACKeyLen)
	badConn, err := grpc.NewClient(
		"passthrough:///ourcordd",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return ipc.DialAuthenticated(ctx, sock, wrong)
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = badConn.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := ourcordv1.NewDaemonServiceClient(badConn).GetStatus(ctx, &ourcordv1.GetStatusRequest{}); err == nil {
		t.Fatal("RPC with wrong IPC key must fail")
	}
}
