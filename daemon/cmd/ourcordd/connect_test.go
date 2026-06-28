package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"

	"github.com/ourcord/ourcord/daemon/pkg/control"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	"github.com/ourcord/ourcord/daemon/pkg/routing"
	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

// fakeTun records IpcSet calls so the test can assert the wg UAPI string the
// connect pipeline produced.
type fakeTun struct {
	mu          sync.Mutex
	upCalled    bool
	closed      bool
	ipcCalls    []string
	ipcGet      string
	v4RouteSync [][]netip.Addr
}

func (f *fakeTun) Up() error    { f.mu.Lock(); defer f.mu.Unlock(); f.upCalled = true; return nil }
func (f *fakeTun) Close() error { f.mu.Lock(); defer f.mu.Unlock(); f.closed = true; return nil }
func (f *fakeTun) Name() string { return "utun-test" }
func (f *fakeTun) ConfigureIPC(s string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ipcCalls = append(f.ipcCalls, s)
	return nil
}
func (f *fakeTun) GetIPC() (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ipcGet, nil
}
func (f *fakeTun) SyncPeerV4Routes(want []netip.Addr) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := append([]netip.Addr(nil), want...)
	f.v4RouteSync = append(f.v4RouteSync, cp)
	return nil
}
func (f *fakeTun) lastIPC() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ipcCalls) == 0 {
		return ""
	}
	return f.ipcCalls[len(f.ipcCalls)-1]
}

func mustTestKey(b byte) wgtypes.Key {
	var k wgtypes.Key
	for i := range k {
		k[i] = b
	}
	return k
}

// fakeClient wraps a real *control.Client pointed at httptest, but stubs Run
// to a no-op so the test doesn't try to open a websocket.
type fakeClient struct {
	*control.Client
	runCalled atomic.Bool
	mu        sync.Mutex
	reports   []control.ConnectivityReport
}

func (f *fakeClient) Run(ctx context.Context, roomID string) {
	f.runCalled.Store(true)
	<-ctx.Done()
}

func (f *fakeClient) ReportConnectivity(_ context.Context, report control.ConnectivityReport) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reports = append(f.reports, report)
	return nil
}

func (f *fakeClient) connectivityReports() []control.ConnectivityReport {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]control.ConnectivityReport(nil), f.reports...)
}

// mockControlPlane returns an httptest.Server that emulates the two endpoints
// the daemon hits during connect(): /api/peers/register and /api/peers/config.
func mockControlPlane(t *testing.T, peerPub string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/peers/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		if got := r.Header.Get("Authorization"); !strings.HasPrefix(got, "Bearer ") {
			http.Error(w, "no bearer", http.StatusUnauthorized)
			return
		}
		var req control.RegisterRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if req.PublicKey == "" {
			http.Error(w, "missing pub", 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(control.RegisterResponse{
			Peer: control.PeerInfo{
				ID: "peer-self", UserID: "u1", PublicKey: req.PublicKey,
				Name: req.Name, Platform: req.Platform,
				IP4: "198.18.0.10", IP6: "fdab:cdef:123::a",
			},
		})
	})
	mux.HandleFunc("/api/peers/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Peer-Public-Key") != peerPub {
			http.Error(w, "wrong pubkey header", http.StatusForbidden)
			return
		}
		// Return one fake remote peer so the wg UAPI string contains a peer block.
		var remoteKey wgtypes.Key
		copy(remoteKey[:], []byte("0123456789abcdef0123456789abcdef"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(control.PeerConfig{
			Peers: []control.RemotePeer{{
				ID:        "peer-other",
				PublicKey: base64.StdEncoding.EncodeToString(remoteKey[:]),
				IP4:       "198.18.0.11",
				IP6:       "fdab:cdef:123::b",
				Name:      "other",
				LastSeen:  1234,
			}},
			Relays: []control.RelayEntry{},
		})
	})
	return httptest.NewServer(mux)
}

func TestConnect_HappyPath_MockControl(t *testing.T) {
	stateDir := t.TempDir()
	tokenPath := filepath.Join(stateDir, "token")
	if err := os.WriteFile(tokenPath, []byte("test-jwt-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	kp, err := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))
	if err != nil {
		t.Fatal(err)
	}

	srv := mockControlPlane(t, kp.PublicKeyBase64())
	defer srv.Close()

	ft := &fakeTun{}
	d := &daemon{
		controlURL: srv.URL,
		keyPair:    kp,
		stateDir:   stateDir,
		newTun: func(name string, addrs []netip.Prefix) (tunIface, error) {
			if len(addrs) != 2 {
				t.Errorf("expected 2 prefixes (v4+v6), got %d: %v", len(addrs), addrs)
			}
			return ft, nil
		},
		newClient: func(url, token, pub string) controlClient {
			if token != "test-jwt-token" {
				t.Errorf("token not loaded from state-dir: %q", token)
			}
			return &fakeClient{Client: control.New(url, token, pub)}
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := d.connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer d.disconnect()

	if !d.vpnActive.Load() {
		t.Fatal("expected vpnActive=true after connect")
	}
	if !ft.upCalled {
		t.Error("tun.Up was never called")
	}
	uapi := ft.lastIPC()
	if uapi == "" {
		t.Fatal("ConfigureIPC was never called")
	}
	if !strings.Contains(uapi, "private_key=") {
		t.Errorf("UAPI missing private_key:\n%s", uapi)
	}
	if !strings.Contains(uapi, "public_key=") {
		t.Errorf("UAPI missing public_key (no remote peer programmed):\n%s", uapi)
	}
	if !strings.Contains(uapi, "allowed_ip=198.18.0.11/32") {
		t.Errorf("UAPI missing remote v4 allowed_ip:\n%s", uapi)
	}
	if !strings.Contains(uapi, "allowed_ip=fdab:cdef:123::b/128") {
		t.Errorf("UAPI missing remote v6 allowed_ip:\n%s", uapi)
	}

	status := d.HandleIPC(context.Background(), ipc.IPCRequest{Cmd: ipc.CmdStatus})
	if !status.OK {
		t.Fatalf("status failed: %s", status.Error)
	}
	st, ok := status.Data.(ipc.DaemonStatus)
	if !ok {
		t.Fatalf("status data has type %T", status.Data)
	}
	if st.PathSummary != "waiting" {
		t.Fatalf("expected waiting path summary before DERP/validated ICE, got %q", st.PathSummary)
	}
	if st.PeerCount != 1 {
		t.Fatalf("expected peer_count=1, got %d", st.PeerCount)
	}

	peersResp := d.HandleIPC(context.Background(), ipc.IPCRequest{Cmd: ipc.CmdListPeers})
	if !peersResp.OK {
		t.Fatalf("list peers failed: %s", peersResp.Error)
	}
	peers, ok := peersResp.Data.([]ipc.ConnectedPeer)
	if !ok {
		t.Fatalf("peers data has type %T", peersResp.Data)
	}
	if len(peers) != 1 {
		t.Fatalf("expected 1 peer, got %d", len(peers))
	}
	if peers[0].Path != "waiting" {
		t.Fatalf("expected peer path waiting, got %q", peers[0].Path)
	}
	if peers[0].LastError != "no-derp-route" {
		t.Fatalf("expected no-derp-route last_error, got %q", peers[0].LastError)
	}
	if peers[0].Name != "other" || peers[0].IP4 != "198.18.0.11" || peers[0].LastSeenSecs != 1234 {
		t.Fatalf("unexpected peer: %+v", peers[0])
	}
}

func TestEnterLeaveRoom_UsesRoomScopedConfigAndReplacesPeers(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "token"), []byte("test-jwt-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	kp, err := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))
	if err != nil {
		t.Fatal(err)
	}

	var roomsSeen []string
	var userKey, roomKey wgtypes.Key
	copy(userKey[:], []byte("user-scope-peer-0000000000000001"))
	copy(roomKey[:], []byte("room-scope-peer-0000000000000001"))
	mux := http.NewServeMux()
	mux.HandleFunc("/api/peers/register", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(control.RegisterResponse{
			Peer: control.PeerInfo{
				ID: "peer-self", UserID: "u1", PublicKey: kp.PublicKeyBase64(),
				Name: "self", Platform: "test",
				IP4: "198.18.0.10", IP6: "fdab:cdef:123::a",
			},
		})
	})
	mux.HandleFunc("/api/peers/config", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.URL.Query().Get("room_id")
		roomsSeen = append(roomsSeen, roomID)
		peer := control.RemotePeer{
			ID:        "user-peer",
			PublicKey: base64.StdEncoding.EncodeToString(userKey[:]),
			IP4:       "198.18.0.11",
			IP6:       "fdab:cdef:123::b",
			Name:      "user-peer",
		}
		if roomID == "room-abc" {
			peer = control.RemotePeer{
				ID:        "room-peer",
				PublicKey: base64.StdEncoding.EncodeToString(roomKey[:]),
				IP4:       "198.18.0.22",
				IP6:       "fdab:cdef:123::16",
				Name:      "room-peer",
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(control.PeerConfig{Peers: []control.RemotePeer{peer}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ft := &fakeTun{}
	d := &daemon{
		controlURL: srv.URL,
		keyPair:    kp,
		stateDir:   stateDir,
		newTun:     func(string, []netip.Prefix) (tunIface, error) { return ft, nil },
		newClient: func(u, t, p string) controlClient {
			return &fakeClient{Client: control.New(u, t, p)}
		},
	}
	if err := d.connect(context.Background()); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer d.disconnect()

	if got := roomsSeen; len(got) != 1 || got[0] != "" {
		t.Fatalf("initial config rooms = %v, want [\"\"]", got)
	}

	resp := d.HandleIPC(context.Background(), ipc.IPCRequest{
		Cmd:    ipc.CmdEnterRoom,
		Params: map[string]string{"room_id": "room-abc"},
	})
	if !resp.OK {
		t.Fatalf("enter room failed: %s", resp.Error)
	}
	if got := roomsSeen; len(got) != 2 || got[1] != "room-abc" {
		t.Fatalf("rooms after enter = %v, want second room-abc", got)
	}
	uapi := ft.lastIPC()
	if !strings.Contains(uapi, "allowed_ip=198.18.0.22/32") {
		t.Fatalf("room peer not applied:\n%s", uapi)
	}
	if strings.Contains(uapi, "allowed_ip=198.18.0.11/32") {
		t.Fatalf("user-scope peer leaked after room replace:\n%s", uapi)
	}
	status := d.HandleIPC(context.Background(), ipc.IPCRequest{Cmd: ipc.CmdStatus})
	st, ok := status.Data.(ipc.DaemonStatus)
	if !ok || st.RoomID != "room-abc" {
		t.Fatalf("status room = %#v (ok=%v)", status.Data, ok)
	}

	resp = d.HandleIPC(context.Background(), ipc.IPCRequest{Cmd: ipc.CmdLeaveRoom})
	if !resp.OK {
		t.Fatalf("leave room failed: %s", resp.Error)
	}
	if got := roomsSeen; len(got) != 3 || got[2] != "" {
		t.Fatalf("rooms after leave = %v, want third empty", got)
	}
	uapi = ft.lastIPC()
	if !strings.Contains(uapi, "allowed_ip=198.18.0.11/32") {
		t.Fatalf("user peer not restored after leave:\n%s", uapi)
	}
	if strings.Contains(uapi, "allowed_ip=198.18.0.22/32") {
		t.Fatalf("room peer leaked after leave:\n%s", uapi)
	}
}

func TestEnterNetwork_UsesNetworkIDParam(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "token"), []byte("test-jwt-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	kp, err := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))
	if err != nil {
		t.Fatal(err)
	}

	var roomsSeen []string
	mux := http.NewServeMux()
	mux.HandleFunc("/api/peers/register", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(control.RegisterResponse{
			Peer: control.PeerInfo{
				ID: "peer-self", UserID: "u1", PublicKey: kp.PublicKeyBase64(),
				Name: "self", Platform: "test",
				IP4: "198.18.0.10", IP6: "fdab:cdef:123::a",
			},
		})
	})
	mux.HandleFunc("/api/peers/config", func(w http.ResponseWriter, r *http.Request) {
		roomsSeen = append(roomsSeen, r.URL.Query().Get("room_id"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(control.PeerConfig{Peers: []control.RemotePeer{}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	d := &daemon{
		controlURL: srv.URL,
		keyPair:    kp,
		stateDir:   stateDir,
		newTun:     func(string, []netip.Prefix) (tunIface, error) { return &fakeTun{}, nil },
		newClient: func(u, t, p string) controlClient {
			return &fakeClient{Client: control.New(u, t, p)}
		},
	}
	if err := d.connect(context.Background()); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer d.disconnect()

	resp := d.HandleIPC(context.Background(), ipc.IPCRequest{
		Cmd:    ipc.CmdEnterNetwork,
		Params: map[string]string{"network_id": "lobby-l1-room-v1-voice"},
	})
	if !resp.OK {
		t.Fatalf("enter network failed: %s", resp.Error)
	}
	if got := roomsSeen; len(got) != 2 || got[1] != "lobby-l1-room-v1-voice" {
		t.Fatalf("rooms after enter-network = %v", got)
	}

	status := d.HandleIPC(context.Background(), ipc.IPCRequest{Cmd: ipc.CmdStatus})
	st, ok := status.Data.(ipc.DaemonStatus)
	if !ok {
		t.Fatalf("status data has type %T", status.Data)
	}
	if st.NetworkID != "lobby-l1-room-v1-voice" || st.RoomID != st.NetworkID {
		t.Fatalf("status network/room = %q/%q", st.NetworkID, st.RoomID)
	}
}

func TestEnterNetworkReportsStartupDERPReachability(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, "token"), []byte("test-jwt-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	kp, err := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))
	if err != nil {
		t.Fatal(err)
	}
	remoteKey := mustTestKey(0x77)
	remotePub := base64.StdEncoding.EncodeToString(remoteKey[:])

	mux := http.NewServeMux()
	mux.HandleFunc("/api/peers/register", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(control.RegisterResponse{
			Peer: control.PeerInfo{
				ID: "peer-self", UserID: "u1", PublicKey: kp.PublicKeyBase64(),
				Name: "self", Platform: "test",
				IP4: "198.18.0.10", IP6: "fdab:cdef:123::a",
			},
		})
	})
	mux.HandleFunc("/api/peers/config", func(w http.ResponseWriter, r *http.Request) {
		roomID := r.URL.Query().Get("room_id")
		cfg := control.PeerConfig{}
		if roomID == "lobby-l1-room-v1-voice" {
			cfg = control.PeerConfig{
				Peers: []control.RemotePeer{{
					ID: "peer-derp", PublicKey: remotePub,
					IP4: "198.18.0.12", IP6: "fdab:cdef:123::12",
					Name: "derp-peer", DERPNodeKey: "nodekey:0123456789abcdef",
				}},
				Relays: []control.RelayEntry{{Hostname: "relay.example.com", Port: 443, Region: "test"}},
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cfg)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	fc := &fakeClient{Client: control.New(srv.URL, "test-jwt-token", kp.PublicKeyBase64())}
	d := &daemon{
		controlURL: srv.URL,
		keyPair:    kp,
		stateDir:   stateDir,
		disableICE: true,
		newTun:     func(string, []netip.Prefix) (tunIface, error) { return &fakeTun{}, nil },
		newClient: func(u, t, p string) controlClient {
			return fc
		},
	}
	if err := d.connect(context.Background()); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer d.disconnect()

	resp := d.HandleIPC(context.Background(), ipc.IPCRequest{
		Cmd:    ipc.CmdEnterNetwork,
		Params: map[string]string{"network_id": "lobby-l1-room-v1-voice"},
	})
	if !resp.OK {
		t.Fatalf("enter network failed: %s", resp.Error)
	}

	var reports []control.ConnectivityReport
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		reports = fc.connectivityReports()
		if len(reports) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(reports) != 1 {
		t.Fatalf("connectivity reports = %+v, want one DERP baseline report", reports)
	}
	got := reports[0]
	if got.NetworkID != "lobby-l1-room-v1-voice" || got.PeerPublicKey != remotePub {
		t.Fatalf("unexpected report identity: %+v", got)
	}
	if got.ICEDirect || got.Direct || !got.WGReachable || got.Transport != "derp" || got.Reason != "derp-baseline" {
		t.Fatalf("unexpected DERP baseline report: %+v", got)
	}
}

func TestApplyConfig_UsesDERPAsStartupFallbackEndpoint(t *testing.T) {
	priv, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	var remoteKey wgtypes.Key
	copy(remoteKey[:], []byte("derp-startup-fallback-peer-0001"))
	ft := &fakeTun{}
	table := routing.NewTable()

	err = applyConfig(ft, table, priv, &control.PeerConfig{
		Peers: []control.RemotePeer{{
			ID:          "peer-derp",
			PublicKey:   base64.StdEncoding.EncodeToString(remoteKey[:]),
			IP4:         "198.18.0.44",
			IP6:         "fdab:cdef:123::44",
			Name:        "derp-peer",
			DERPNodeKey: "nodekey:0123456789abcdef",
		}},
		Relays: []control.RelayEntry{{Hostname: "relay.example.com", Port: 443, Region: "test"}},
	})
	if err != nil {
		t.Fatalf("applyConfig: %v", err)
	}

	uapi := ft.lastIPC()
	if !strings.Contains(uapi, "endpoint=derp://") {
		t.Fatalf("expected DERP endpoint as startup fallback:\n%s", uapi)
	}
	if strings.Contains(uapi, "endpoint=ice://") {
		t.Fatalf("startup fallback must not claim ICE before validation:\n%s", uapi)
	}
}

func TestStartICEForRoutes_Disabled(t *testing.T) {
	d := &daemon{disableICE: true}
	// Should be a no-op even with routes present and no iceMgr.
	d.startICEForRoutes(context.Background(), []*routing.PeerRoute{{
		PublicKey: mustTestKey(0x42),
		VPN4:      netip.MustParseAddr("198.18.0.66"),
	}})
}

func TestStartICEForRoutes_SkipsDegradedPeer(t *testing.T) {
	d := &daemon{}
	// Should be a no-op even with routes present and no iceMgr: degraded peers
	// stay on DERP until the retry loop probes and clears LastError.
	d.startICEForRoutes(context.Background(), []*routing.PeerRoute{{
		PublicKey: mustTestKey(0x43),
		VPN4:      netip.MustParseAddr("198.18.0.67"),
		LastError: "direct-health-degraded",
	}})
}

func TestMarkPeerICEReady_UpgradesAndClearsBackoff(t *testing.T) {
	// onReady only fires after the ICE manager's sustained-reliability probe, so
	// a previously-degraded peer must re-upgrade: ICEReady set, LastError and the
	// backoff entry cleared.
	priv, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	pk := mustTestKey(0x44)
	table := routing.NewTable()
	table.Upsert(&routing.PeerRoute{
		PublicKey: pk,
		VPN4:      netip.MustParseAddr("198.18.0.68"),
		LastError: "direct-health-lost",
	})
	d := &daemon{
		keyPair:  &wg.KeyPair{Private: priv},
		table:    table,
		tunIf:    &fakeTun{},
		connCtx:  context.Background(),
		iceRetry: map[wgtypes.Key]*iceRetryState{pk: {interval: 40 * time.Second}},
	}

	d.markPeerICEReady(pk.String())

	routes := table.All()
	if len(routes) != 1 || !routes[0].ICEReady || routes[0].ICEPending || routes[0].LastError != "" {
		t.Fatalf("confirmed ICE peer should upgrade and clear degrade, got %+v", routes)
	}
	if _, ok := d.iceRetry[pk]; ok {
		t.Fatal("backoff entry should be cleared on successful upgrade")
	}
}

func TestMarkPeerICEReady_ClearsNextHopForDirectRecovery(t *testing.T) {
	priv, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	pk := mustTestKey(0x45)
	hop := mustTestKey(0x46)
	ft := &fakeTun{}
	table := routing.NewTable()
	table.Upsert(&routing.PeerRoute{
		PublicKey:   pk,
		VPN4:        netip.MustParseAddr("198.18.0.69"),
		NextHop:     &hop,
		DERPURL:     "https://relay.example.com/derp",
		DERPNodeKey: "nodekey:0123456789abcdef",
	})
	d := &daemon{
		keyPair:  &wg.KeyPair{Private: priv},
		table:    table,
		tunIf:    ft,
		connCtx:  context.Background(),
		iceRetry: map[wgtypes.Key]*iceRetryState{pk: {interval: 40 * time.Second}},
	}

	d.markPeerICEReady(pk.String())

	routes := table.All()
	if len(routes) != 1 || routes[0].NextHop != nil || !routes[0].ICEReady {
		t.Fatalf("confirmed ICE should switch next-hop peer to direct, got %+v", routes)
	}
	if _, ok := d.iceRetry[pk]; ok {
		t.Fatal("backoff entry should be cleared on successful direct recovery")
	}
	uapi := ft.lastIPC()
	if !strings.Contains(uapi, "allowed_ip=198.18.0.69/32\n") || !strings.Contains(uapi, "endpoint=ice://") {
		t.Fatalf("direct recovery did not apply direct WireGuard config:\n%s", uapi)
	}
	if strings.Contains(uapi, "endpoint=derp://") {
		t.Fatalf("direct recovery must not keep DERP endpoint:\n%s", uapi)
	}
}

func TestStartSignalLocked_DisabledICE(t *testing.T) {
	d := &daemon{
		disableICE: true,
		cli:        &fakeClient{},
		connCtx:    context.Background(),
	}

	d.startSignalLocked("network-a")

	if d.sigCxl != nil {
		t.Fatal("expected SignalDO client to stay stopped when ICE is disabled")
	}
}

func TestFailPeerICEValidation_RevertsToDERPEndpoint(t *testing.T) {
	priv, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	var remoteKey wgtypes.Key
	copy(remoteKey[:], []byte("derp-runtime-fallback-peer-0001"))
	peerKey := base64.StdEncoding.EncodeToString(remoteKey[:])
	ft := &fakeTun{}
	table := routing.NewTable()
	table.Upsert(&routing.PeerRoute{
		PublicKey:   remoteKey,
		VPN4:        netip.MustParseAddr("198.18.0.55"),
		ICEReady:    true,
		DERPURL:     "https://relay.example.com/derp",
		DERPNodeKey: "nodekey:0123456789abcdef",
	})
	if err := ft.ConfigureIPC(table.BuildIPCConfig(priv)); err != nil {
		t.Fatal(err)
	}

	fc := &fakeClient{}
	d := &daemon{
		keyPair:    &wg.KeyPair{Private: priv},
		tunIf:      ft,
		table:      table,
		cli:        fc,
		activeRoom: "lobby-l1-room-v1-voice",
		connCtx:    context.Background(),
	}
	d.failPeerICEValidation(peerKey, remoteKey, "direct-health-degraded")

	uapi := ft.lastIPC()
	if !strings.Contains(uapi, "endpoint=derp://") {
		t.Fatalf("expected DERP endpoint after ICE failure:\n%s", uapi)
	}
	if strings.Contains(uapi, "endpoint=ice://") {
		t.Fatalf("failed ICE route must not keep ICE endpoint:\n%s", uapi)
	}
	peers := connectedPeers(table.All())
	if len(peers) != 1 || peers[0].Path != "degraded" || peers[0].LastError != "direct-health-degraded" {
		t.Fatalf("unexpected peer status after fallback: %+v", peers)
	}
	var reports []control.ConnectivityReport
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		reports = fc.connectivityReports()
		if len(reports) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(reports) != 1 {
		t.Fatalf("connectivity reports = %+v, want one DERP fallback report", reports)
	}
	if got := reports[0]; got.ICEDirect || got.Direct || !got.WGReachable || got.Transport != "derp" || got.Reason != "derp-fallback:direct-health-degraded" {
		t.Fatalf("unexpected fallback connectivity report: %+v", got)
	}
}

func TestForceDERP_IPCDiagnosticRevertsEndpoint(t *testing.T) {
	priv, err := wgtypes.GeneratePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	remoteKey := mustTestKey(0x66)
	peerKey := remoteKey.String()
	ft := &fakeTun{}
	table := routing.NewTable()
	table.Upsert(&routing.PeerRoute{
		PublicKey:   remoteKey,
		VPN4:        netip.MustParseAddr("198.18.0.77"),
		ICEReady:    true,
		DERPURL:     "https://relay.example.com/derp",
		DERPNodeKey: "nodekey:0123456789abcdef",
	})
	if err := ft.ConfigureIPC(table.BuildIPCConfig(priv)); err != nil {
		t.Fatal(err)
	}

	d := &daemon{keyPair: &wg.KeyPair{Private: priv}, tunIf: ft, table: table}
	d.vpnActive.Store(true)
	resp := d.HandleIPC(context.Background(), ipc.IPCRequest{
		Cmd:    ipc.CmdForceDERP,
		Params: map[string]string{"public_key": peerKey, "reason": "test-force"},
	})
	if !resp.OK {
		t.Fatalf("force-derp failed: %s", resp.Error)
	}
	uapi := ft.lastIPC()
	if !strings.Contains(uapi, "endpoint=derp://") || strings.Contains(uapi, "endpoint=ice://") {
		t.Fatalf("force-derp did not switch endpoint:\n%s", uapi)
	}
	peers := connectedPeers(table.All())
	if len(peers) != 1 || peers[0].Path != "degraded" || peers[0].LastError != "test-force" {
		t.Fatalf("unexpected peer status: %+v", peers)
	}
}

func TestConnect_MissingToken_Fails(t *testing.T) {
	stateDir := t.TempDir() // no token file
	kp, _ := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))
	d := &daemon{
		controlURL: "http://127.0.0.1:1",
		keyPair:    kp,
		stateDir:   stateDir,
	}
	err := d.connect(context.Background())
	if err == nil {
		t.Fatal("expected error when token missing")
	}
	if !strings.Contains(err.Error(), "load auth token") {
		t.Errorf("unexpected error: %v", err)
	}
	if d.vpnActive.Load() {
		t.Error("vpnActive must remain false on connect failure")
	}
}

func TestConnect_RegisterHTTPError_TearsDown(t *testing.T) {
	stateDir := t.TempDir()
	os.WriteFile(filepath.Join(stateDir, "token"), []byte("t"), 0o600)
	kp, _ := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "ip pool exhausted", http.StatusInternalServerError)
	}))
	defer srv.Close()

	ft := &fakeTun{}
	d := &daemon{
		controlURL: srv.URL,
		keyPair:    kp,
		stateDir:   stateDir,
		newTun:     func(string, []netip.Prefix) (tunIface, error) { return ft, nil },
	}
	if err := d.connect(context.Background()); err == nil {
		t.Fatal("expected register failure")
	}
	if d.vpnActive.Load() {
		t.Error("vpnActive must be false")
	}
	if ft.upCalled {
		t.Error("TUN must not be brought up if register failed")
	}
}

func TestConnect_DoubleConnect_Rejected(t *testing.T) {
	stateDir := t.TempDir()
	os.WriteFile(filepath.Join(stateDir, "token"), []byte("t"), 0o600)
	kp, _ := wg.LoadOrCreateKeyPair(filepath.Join(stateDir, "wg.key"))
	srv := mockControlPlane(t, kp.PublicKeyBase64())
	defer srv.Close()

	d := &daemon{
		controlURL: srv.URL,
		keyPair:    kp,
		stateDir:   stateDir,
		newTun:     func(string, []netip.Prefix) (tunIface, error) { return &fakeTun{}, nil },
		newClient: func(u, t, p string) controlClient {
			return &fakeClient{Client: control.New(u, t, p)}
		},
	}
	if err := d.connect(context.Background()); err != nil {
		t.Fatalf("first connect: %v", err)
	}
	defer d.disconnect()
	if err := d.connect(context.Background()); err == nil {
		t.Fatal("second connect should fail with already-active error")
	}
}
