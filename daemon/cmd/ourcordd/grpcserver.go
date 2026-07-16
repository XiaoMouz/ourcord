package main

import (
	"context"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	ourcordv1 "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// gRPC service adapters. They translate the proto RPCs onto the daemon's
// internal HandleIPC mux, so all command semantics (locking, validation,
// side effects) stay in one place. Per the proto contract, transport-level
// problems become RPC status errors; operation-specific failures ride
// OperationResult{ok:false}.

// registerGRPCServices wires all services onto srv.
func registerGRPCServices(srv *grpc.Server, d *daemon) {
	ourcordv1.RegisterDaemonServiceServer(srv, &daemonService{d: d})
	ourcordv1.RegisterDaemonDiagnosticsServiceServer(srv, &diagnosticsService{d: d})
	ourcordv1.RegisterDaemonVoiceServiceServer(srv, &voiceService{d: d})
}

type daemonService struct {
	ourcordv1.UnimplementedDaemonServiceServer
	d *daemon
}

func (s *daemonService) GetStatus(ctx context.Context, _ *ourcordv1.GetStatusRequest) (*ourcordv1.GetStatusResponse, error) {
	resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: ipc.CmdStatus})
	st, ok := resp.Data.(ipc.DaemonStatus)
	if !resp.OK || !ok {
		return nil, status.Error(codes.Internal, orMsg(resp.Error, "status unavailable"))
	}
	return &ourcordv1.GetStatusResponse{Status: ipc.StatusToProto(st)}, nil
}

func (s *daemonService) ListPeers(ctx context.Context, _ *ourcordv1.ListPeersRequest) (*ourcordv1.ListPeersResponse, error) {
	resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: ipc.CmdListPeers})
	peers, ok := resp.Data.([]ipc.ConnectedPeer)
	if !resp.OK || !ok {
		return nil, status.Error(codes.Internal, orMsg(resp.Error, "peers unavailable"))
	}
	return &ourcordv1.ListPeersResponse{Peers: ipc.PeersToProto(peers)}, nil
}

func (s *daemonService) Connect(ctx context.Context, _ *ourcordv1.ConnectRequest) (*ourcordv1.ConnectResponse, error) {
	return &ourcordv1.ConnectResponse{Result: s.op(ctx, ipc.CmdConnect, nil)}, nil
}

func (s *daemonService) Disconnect(ctx context.Context, _ *ourcordv1.DisconnectRequest) (*ourcordv1.DisconnectResponse, error) {
	return &ourcordv1.DisconnectResponse{Result: s.op(ctx, ipc.CmdDisconnect, nil)}, nil
}

func (s *daemonService) EnterNetwork(ctx context.Context, req *ourcordv1.EnterNetworkRequest) (*ourcordv1.EnterNetworkResponse, error) {
	params := map[string]string{"network_id": req.GetNetworkId()}
	return &ourcordv1.EnterNetworkResponse{Result: s.op(ctx, ipc.CmdEnterNetwork, params)}, nil
}

func (s *daemonService) LeaveNetwork(ctx context.Context, _ *ourcordv1.LeaveNetworkRequest) (*ourcordv1.LeaveNetworkResponse, error) {
	return &ourcordv1.LeaveNetworkResponse{Result: s.op(ctx, ipc.CmdLeaveNetwork, nil)}, nil
}

// op runs a mutating command and folds the outcome into an OperationResult.
func (s *daemonService) op(ctx context.Context, cmd string, params map[string]string) *ourcordv1.OperationResult {
	resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: cmd, Params: params})
	return &ourcordv1.OperationResult{Ok: resp.OK, ErrorMessage: resp.Error}
}

type diagnosticsService struct {
	ourcordv1.UnimplementedDaemonDiagnosticsServiceServer
	d *daemon
}

func (s *diagnosticsService) Ping(ctx context.Context, _ *ourcordv1.PingRequest) (*ourcordv1.PingResponse, error) {
	if resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: ipc.CmdPing}); !resp.OK {
		return nil, status.Error(codes.Internal, orMsg(resp.Error, "ping failed"))
	}
	return &ourcordv1.PingResponse{}, nil
}

func (s *diagnosticsService) ForceDERP(ctx context.Context, req *ourcordv1.ForceDERPRequest) (*ourcordv1.ForceDERPResponse, error) {
	params := map[string]string{"public_key": req.GetPeerPublicKey(), "reason": req.GetReason()}
	resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: ipc.CmdForceDERP, Params: params})
	return &ourcordv1.ForceDERPResponse{Result: &ourcordv1.OperationResult{Ok: resp.OK, ErrorMessage: resp.Error}}, nil
}

type voiceService struct {
	ourcordv1.UnimplementedDaemonVoiceServiceServer
	d *daemon
}

func (s *voiceService) VoiceJoin(ctx context.Context, _ *ourcordv1.VoiceJoinRequest) (*ourcordv1.VoiceJoinResponse, error) {
	return &ourcordv1.VoiceJoinResponse{Result: s.op(ctx, ipc.CmdVoiceJoin, nil)}, nil
}

func (s *voiceService) VoiceLeave(ctx context.Context, _ *ourcordv1.VoiceLeaveRequest) (*ourcordv1.VoiceLeaveResponse, error) {
	return &ourcordv1.VoiceLeaveResponse{Result: s.op(ctx, ipc.CmdVoiceLeave, nil)}, nil
}

func (s *voiceService) SetMute(ctx context.Context, req *ourcordv1.SetMuteRequest) (*ourcordv1.SetMuteResponse, error) {
	return &ourcordv1.SetMuteResponse{Result: s.op(ctx, ipc.CmdVoiceMute, boolParam(req.GetMuted()))}, nil
}

func (s *voiceService) SetDeafen(ctx context.Context, req *ourcordv1.SetDeafenRequest) (*ourcordv1.SetDeafenResponse, error) {
	return &ourcordv1.SetDeafenResponse{Result: s.op(ctx, ipc.CmdVoiceDeafen, boolParam(req.GetDeafened()))}, nil
}

func (s *voiceService) GetVoiceStatus(ctx context.Context, _ *ourcordv1.GetVoiceStatusRequest) (*ourcordv1.GetVoiceStatusResponse, error) {
	resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: ipc.CmdVoiceStatus})
	st, ok := resp.Data.(ipc.VoiceStatus)
	if !resp.OK || !ok {
		return nil, status.Error(codes.Internal, orMsg(resp.Error, "voice status unavailable"))
	}
	return &ourcordv1.GetVoiceStatusResponse{Status: ipc.VoiceStatusToProto(st)}, nil
}

func (s *voiceService) ListAudioDevices(ctx context.Context, _ *ourcordv1.ListAudioDevicesRequest) (*ourcordv1.ListAudioDevicesResponse, error) {
	resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: ipc.CmdVoiceListDevices})
	if !resp.OK {
		return &ourcordv1.ListAudioDevicesResponse{Result: &ourcordv1.OperationResult{Ok: false, ErrorMessage: resp.Error}}, nil
	}
	list, _ := resp.Data.(ipc.AudioDeviceList)
	return &ourcordv1.ListAudioDevicesResponse{
		Result:   &ourcordv1.OperationResult{Ok: true},
		Capture:  ipc.AudioDevicesToProto(list.Capture),
		Playback: ipc.AudioDevicesToProto(list.Playback),
	}, nil
}

func (s *voiceService) SetAudioDevices(ctx context.Context, req *ourcordv1.SetAudioDevicesRequest) (*ourcordv1.SetAudioDevicesResponse, error) {
	params := map[string]string{"capture_id": req.GetCaptureId(), "playback_id": req.GetPlaybackId()}
	return &ourcordv1.SetAudioDevicesResponse{Result: s.op(ctx, ipc.CmdVoiceSetDevices, params)}, nil
}

func (s *voiceService) op(ctx context.Context, cmd string, params map[string]string) *ourcordv1.OperationResult {
	resp := s.d.HandleIPC(ctx, ipc.IPCRequest{Cmd: cmd, Params: params})
	return &ourcordv1.OperationResult{Ok: resp.OK, ErrorMessage: resp.Error}
}

func boolParam(v bool) map[string]string {
	if v {
		return map[string]string{"on": "true"}
	}
	return map[string]string{"on": "false"}
}

func orMsg(msg, fallback string) string {
	if msg != "" {
		return msg
	}
	return fallback
}
