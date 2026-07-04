package control

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPairRoomID_URLSafeAndStable(t *testing.T) {
	var aRaw, bRaw [32]byte
	for i := range aRaw {
		aRaw[i] = byte(i)
		bRaw[i] = byte(255 - i)
	}
	a := base64.StdEncoding.EncodeToString(aRaw[:])
	b := base64.StdEncoding.EncodeToString(bRaw[:])
	ab, err := PairRoomID(a, b)
	if err != nil {
		t.Fatalf("PairRoomID: %v", err)
	}
	ba, err := PairRoomID(b, a)
	if err != nil {
		t.Fatalf("PairRoomID reversed: %v", err)
	}
	if ab != ba {
		t.Fatalf("room id must be order-stable: %q != %q", ab, ba)
	}
	if strings.ContainsAny(ab, "/+=") {
		t.Fatalf("room id is not URL safe: %q", ab)
	}
	if !strings.HasPrefix(ab, "pair:") || !strings.Contains(ab, ".") {
		t.Fatalf("unexpected room id shape: %q", ab)
	}
}

// newTestClient builds a Client whose controlURL points at the given test
// server. Token + public key are fixed so request-header assertions can
// compare against known values.
func newTestClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	c := New(srv.URL, "test-token", "pk-abc")
	// Tighten the timeout so a misbehaving handler can't stall the suite.
	c.http = &http.Client{Timeout: 5 * time.Second}
	return c
}

func TestRegister_Success(t *testing.T) {
	t.Parallel()

	var gotAuth, gotCT, gotMethod, gotPath string
	var gotBody RegisterRequest

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		gotMethod = r.Method
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(RegisterResponse{
			Peer: PeerInfo{
				ID:        "peer-1",
				UserID:    "user-1",
				PublicKey: "pk-abc",
				Name:      "laptop",
				Platform:  "darwin",
				IP4:       "10.0.0.2",
				IP6:       "fd00::2",
			},
			Config: "[Interface]\nPrivateKey = ...\n",
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	resp, err := c.Register(context.Background(), RegisterRequest{
		PublicKey: "pk-abc",
		Name:      "laptop",
		Platform:  "darwin",
	})
	if err != nil {
		t.Fatalf("Register: unexpected error: %v", err)
	}

	if gotMethod != "POST" {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/api/peers/register" {
		t.Errorf("path = %q, want /api/peers/register", gotPath)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer test-token")
	}
	if gotCT != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotCT)
	}
	if gotBody.PublicKey != "pk-abc" || gotBody.Name != "laptop" || gotBody.Platform != "darwin" {
		t.Errorf("server received unexpected body: %+v", gotBody)
	}

	if resp.Peer.ID != "peer-1" || resp.Peer.IP4 != "10.0.0.2" || resp.Peer.IP6 != "fd00::2" {
		t.Errorf("Register parsed peer wrong: %+v", resp.Peer)
	}
	if !strings.Contains(resp.Config, "[Interface]") {
		t.Errorf("Register parsed config wrong: %q", resp.Config)
	}
}

func TestRegister_HTTPErrors(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		status     int
		body       string
		wantSubstr string
	}{
		{"unauthorized", http.StatusUnauthorized, `{"error":"bad token"}`, "HTTP 401"},
		{"forbidden", http.StatusForbidden, "forbidden", "HTTP 403"},
		{"server_error", http.StatusInternalServerError, "boom", "HTTP 500"},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()

			c := newTestClient(t, srv)
			resp, err := c.Register(context.Background(), RegisterRequest{PublicKey: "pk-abc"})
			if err == nil {
				t.Fatalf("expected error, got resp=%+v", resp)
			}
			if !strings.Contains(err.Error(), tc.wantSubstr) {
				t.Errorf("error %q does not contain %q", err.Error(), tc.wantSubstr)
			}
		})
	}
}

func TestRegister_BadJSON(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{not json")
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	if _, err := c.Register(context.Background(), RegisterRequest{}); err == nil {
		t.Fatal("expected decode error, got nil")
	}
}

func TestRegister_NetworkError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Close() // immediate close → connection refused

	c := newTestClient(t, srv)
	_, err := c.Register(context.Background(), RegisterRequest{})
	if err == nil {
		t.Fatal("expected network error, got nil")
	}
	if !strings.Contains(err.Error(), "control register") {
		t.Errorf("error %q lacks expected wrap prefix", err.Error())
	}
}

func TestFetchConfig_Success(t *testing.T) {
	t.Parallel()

	var gotAuth, gotPK, gotMethod, gotPath, gotRoom string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPK = r.Header.Get("X-Peer-Public-Key")
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotRoom = r.URL.Query().Get("room_id")

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(PeerConfig{
			Peers: []RemotePeer{
				{ID: "p1", PublicKey: "pk1", IP4: "10.0.0.3", IP6: "fd00::3", Name: "phone"},
				{ID: "p2", PublicKey: "pk2", IP4: "10.0.0.4", Endpoint: "1.2.3.4:51820"},
			},
			Relays: []RelayEntry{
				{Hostname: "derp1.example.com", Port: 443, Region: "sfo"},
			},
		})
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	cfg, err := c.FetchConfig(context.Background(), "room-xyz")
	if err != nil {
		t.Fatalf("FetchConfig: %v", err)
	}

	if gotMethod != "GET" {
		t.Errorf("method = %q, want GET", gotMethod)
	}
	if gotPath != "/api/peers/config" {
		t.Errorf("path = %q, want /api/peers/config", gotPath)
	}
	if gotRoom != "room-xyz" {
		t.Errorf("room_id query = %q, want room-xyz", gotRoom)
	}
	if gotAuth != "Bearer test-token" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if gotPK != "pk-abc" {
		t.Errorf("X-Peer-Public-Key = %q, want pk-abc", gotPK)
	}

	if len(cfg.Peers) != 2 {
		t.Fatalf("len(peers) = %d, want 2", len(cfg.Peers))
	}
	if cfg.Peers[0].ID != "p1" || cfg.Peers[0].IP4 != "10.0.0.3" {
		t.Errorf("peer[0] wrong: %+v", cfg.Peers[0])
	}
	if cfg.Peers[1].Endpoint != "1.2.3.4:51820" {
		t.Errorf("peer[1] endpoint wrong: %q", cfg.Peers[1].Endpoint)
	}
	if len(cfg.Relays) != 1 || cfg.Relays[0].Hostname != "derp1.example.com" {
		t.Errorf("relays wrong: %+v", cfg.Relays)
	}
}

func TestFetchConfig_OmitsRoomQueryWhenEmpty(t *testing.T) {
	t.Parallel()

	var gotRawQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRawQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"peers":[],"relays":[]}`)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	cfg, err := c.FetchConfig(context.Background(), "")
	if err != nil {
		t.Fatalf("FetchConfig: %v", err)
	}
	if gotRawQuery != "" {
		t.Errorf("expected no query string, got %q", gotRawQuery)
	}
	if len(cfg.Peers) != 0 || len(cfg.Relays) != 0 {
		t.Errorf("expected empty config, got %+v", cfg)
	}
}

func TestFetchConfig_EmptyOrMissingPeers(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		body string
	}{
		{"empty_peers_array", `{"peers":[],"relays":[]}`},
		{"missing_peers_field", `{"relays":[]}`},
		{"empty_object", `{}`},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()

			c := newTestClient(t, srv)
			cfg, err := c.FetchConfig(context.Background(), "")
			if err != nil {
				t.Fatalf("FetchConfig: %v", err)
			}
			if len(cfg.Peers) != 0 {
				t.Errorf("expected 0 peers, got %d", len(cfg.Peers))
			}
		})
	}
}

func TestFetchConfig_HTTPError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, "nope")
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	_, err := c.FetchConfig(context.Background(), "")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "HTTP 401") {
		t.Errorf("error %q does not mention HTTP 401", err.Error())
	}
}

func TestFetchConfig_ContextCancelled(t *testing.T) {
	t.Parallel()
	// Server blocks until the client gives up so the request must fail with
	// the cancelled context, not succeed.
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer srv.Close()
	defer close(block)

	c := newTestClient(t, srv)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := c.FetchConfig(ctx, ""); err == nil {
		t.Fatal("expected error from cancelled context, got nil")
	}
}

func TestReportConnectivity_SendsSequenceMetadata(t *testing.T) {
	t.Parallel()

	var gotAuth, gotPeer, gotCT string
	var gotBody ConnectivityReport
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPeer = r.Header.Get("X-Peer-Public-Key")
		gotCT = r.Header.Get("Content-Type")
		if r.URL.Path != "/api/peers/connectivity" {
			t.Errorf("path = %q, want /api/peers/connectivity", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := newTestClient(t, srv)
	err := c.ReportConnectivity(context.Background(), ConnectivityReport{
		NetworkID:     "lobby-l1-r1-voice",
		PeerPublicKey: "peer-key",
		ICEDirect:     true,
		Direct:        true,
		WGReachable:   true,
		Transport:     "ice",
		Source:        "ice",
		ReporterEpoch: "epoch_123456",
		Seq:           7,
		ObservedAt:    1_700_000_000,
	})
	if err != nil {
		t.Fatalf("ReportConnectivity: %v", err)
	}
	if gotAuth != "Bearer test-token" || gotPeer != "pk-abc" || gotCT != "application/json" {
		t.Fatalf("unexpected headers auth=%q peer=%q content-type=%q", gotAuth, gotPeer, gotCT)
	}
	if gotBody.Source != "ice" || gotBody.ReporterEpoch != "epoch_123456" || gotBody.Seq != 7 || gotBody.ObservedAt != 1_700_000_000 {
		t.Fatalf("sequence metadata not preserved: %+v", gotBody)
	}
}
