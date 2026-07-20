package client

import (
	"context"
	"net"
	"strings"
	"sync"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"

	ourcordv1 "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
)

// orchestrationStub serves configurable daemon state and records mutating
// calls in order, so tests can assert which branch JoinVoiceNetwork took.
type orchestrationStub struct {
	ourcordv1.UnimplementedDaemonServiceServer
	ourcordv1.UnimplementedDaemonVoiceServiceServer

	mu        sync.Mutex
	joined    bool
	networkID string
	vpnActive bool
	calls     []string
}

func (s *orchestrationStub) record(call string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, call)
}

func (s *orchestrationStub) recorded() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

func (s *orchestrationStub) GetStatus(context.Context, *ourcordv1.GetStatusRequest) (*ourcordv1.GetStatusResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &ourcordv1.GetStatusResponse{Status: &ourcordv1.DaemonStatus{
		Running: true, VpnActive: s.vpnActive, NetworkId: s.networkID,
	}}, nil
}

func (s *orchestrationStub) GetVoiceStatus(context.Context, *ourcordv1.GetVoiceStatusRequest) (*ourcordv1.GetVoiceStatusResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &ourcordv1.GetVoiceStatusResponse{Status: &ourcordv1.VoiceStatus{Joined: s.joined}}, nil
}

func (s *orchestrationStub) VoiceLeave(context.Context, *ourcordv1.VoiceLeaveRequest) (*ourcordv1.VoiceLeaveResponse, error) {
	s.record("voice-leave")
	return &ourcordv1.VoiceLeaveResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (s *orchestrationStub) LeaveNetwork(context.Context, *ourcordv1.LeaveNetworkRequest) (*ourcordv1.LeaveNetworkResponse, error) {
	s.record("leave-network")
	return &ourcordv1.LeaveNetworkResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (s *orchestrationStub) Connect(context.Context, *ourcordv1.ConnectRequest) (*ourcordv1.ConnectResponse, error) {
	s.record("connect")
	return &ourcordv1.ConnectResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (s *orchestrationStub) EnterNetwork(_ context.Context, req *ourcordv1.EnterNetworkRequest) (*ourcordv1.EnterNetworkResponse, error) {
	s.record("enter-network:" + req.GetNetworkId())
	return &ourcordv1.EnterNetworkResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (s *orchestrationStub) SetVoiceInputMode(_ context.Context, req *ourcordv1.SetVoiceInputModeRequest) (*ourcordv1.SetVoiceInputModeResponse, error) {
	s.record("input-mode:" + req.GetMode().String())
	return &ourcordv1.SetVoiceInputModeResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func (s *orchestrationStub) VoiceJoin(context.Context, *ourcordv1.VoiceJoinRequest) (*ourcordv1.VoiceJoinResponse, error) {
	s.record("voice-join")
	return &ourcordv1.VoiceJoinResponse{Result: &ourcordv1.OperationResult{Ok: true}}, nil
}

func dialOrchestrationStub(t *testing.T, stub *orchestrationStub) *Client {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	ourcordv1.RegisterDaemonServiceServer(srv, stub)
	ourcordv1.RegisterDaemonVoiceServiceServer(srv, stub)
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

func TestJoinVoiceNetworkRequiresNetworkID(t *testing.T) {
	stub := &orchestrationStub{}
	if err := dialOrchestrationStub(t, stub).JoinVoiceNetwork("", nil); err == nil {
		t.Fatal("expected an error for empty network id")
	}
	if calls := stub.recorded(); len(calls) != 0 {
		t.Fatalf("no RPCs expected, got %v", calls)
	}
}

func TestJoinVoiceNetworkAlreadyThereIsNoop(t *testing.T) {
	stub := &orchestrationStub{joined: true, networkID: "lobby-x-voice", vpnActive: true}
	if err := dialOrchestrationStub(t, stub).JoinVoiceNetwork("lobby-x-voice", nil); err != nil {
		t.Fatal(err)
	}
	if calls := stub.recorded(); len(calls) != 0 {
		t.Fatalf("no mutating calls expected, got %v", calls)
	}
}

func TestJoinVoiceNetworkSwitchesFromOtherNetwork(t *testing.T) {
	stub := &orchestrationStub{joined: true, networkID: "lobby-old", vpnActive: true}
	if err := dialOrchestrationStub(t, stub).JoinVoiceNetwork("lobby-new", nil); err != nil {
		t.Fatal(err)
	}
	want := "voice-leave,leave-network,enter-network:lobby-new,voice-join"
	if got := strings.Join(stub.recorded(), ","); got != want {
		t.Fatalf("call order:\n got %s\nwant %s", got, want)
	}
}

func TestJoinVoiceNetworkColdStartWithPrefs(t *testing.T) {
	stub := &orchestrationStub{}
	prefs := &VoiceInputPrefs{Mode: "push_to_talk", ThresholdDBFS: -50, HangoverMS: 200}
	if err := dialOrchestrationStub(t, stub).JoinVoiceNetwork("lobby-x-voice", prefs); err != nil {
		t.Fatal(err)
	}
	want := "connect,enter-network:lobby-x-voice,input-mode:VOICE_INPUT_MODE_PUSH_TO_TALK,voice-join"
	if got := strings.Join(stub.recorded(), ","); got != want {
		t.Fatalf("call order:\n got %s\nwant %s", got, want)
	}
}
