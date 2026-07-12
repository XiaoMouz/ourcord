package main

import (
	"context"
	"net/netip"
	"testing"

	ourcordv1 "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
	"github.com/ourcord/ourcord/daemon/pkg/routing"
)

func TestGRPCGetStatusMapsDomainToProto(t *testing.T) {
	d := &daemon{table: routing.NewTable()}
	d.table.Upsert(&routing.PeerRoute{
		PublicKey: mustTestKey(0x81),
		VPN4:      netip.MustParseAddr("198.18.0.9"),
		ICEReady:  true,
	})
	d.vpnActive.Store(true)
	d.assignedIP4 = "198.18.0.2"
	d.activeRoom = "lobby-x-voice"

	svc := &daemonService{d: d}
	resp, err := svc.GetStatus(context.Background(), &ourcordv1.GetStatusRequest{})
	if err != nil {
		t.Fatal(err)
	}
	st := resp.GetStatus()
	if !st.GetRunning() || !st.GetVpnActive() || st.GetIpv4() != "198.18.0.2" ||
		st.GetNetworkId() != "lobby-x-voice" || st.GetPeerCount() != 1 ||
		st.GetPathSummary() != ourcordv1.Path_PATH_DIRECT {
		t.Fatalf("unexpected proto status: %+v", st)
	}

	peers, err := svc.ListPeers(context.Background(), &ourcordv1.ListPeersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(peers.GetPeers()) != 1 || peers.GetPeers()[0].GetPath() != ourcordv1.Path_PATH_DIRECT {
		t.Fatalf("unexpected proto peers: %+v", peers.GetPeers())
	}
}

func TestGRPCEnterNetworkValidationRidesOperationResult(t *testing.T) {
	svc := &daemonService{d: &daemon{}}
	resp, err := svc.EnterNetwork(context.Background(), &ourcordv1.EnterNetworkRequest{})
	if err != nil {
		t.Fatalf("validation failures must not be RPC errors: %v", err)
	}
	if res := resp.GetResult(); res.GetOk() || res.GetErrorMessage() != "network_id required" {
		t.Fatalf("unexpected result: %+v", res)
	}
}

func TestGRPCDiagnosticsForceDERPValidation(t *testing.T) {
	svc := &diagnosticsService{d: &daemon{}}
	resp, err := svc.ForceDERP(context.Background(), &ourcordv1.ForceDERPRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if res := resp.GetResult(); res.GetOk() || res.GetErrorMessage() != "public_key required" {
		t.Fatalf("unexpected result: %+v", res)
	}
	if _, err := svc.Ping(context.Background(), &ourcordv1.PingRequest{}); err != nil {
		t.Fatalf("ping: %v", err)
	}
}
