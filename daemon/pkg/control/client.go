// Package control implements the daemon's WebSocket connection to the OurCord control plane.
// Handles peer registration, config fetching, and hole-punching signal exchange.
package control

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

// SignalMessage is a message exchanged over the signaling WebSocket.
type SignalMessage struct {
	Type    string          `json:"type"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Peers   []string        `json:"peers,omitempty"`
}

// PairRoomID returns the URL-safe SignalDO room for a pair of WireGuard public
// keys. Inputs are standard base64 WireGuard keys; output avoids "/" and "="
// so it can be embedded in /api/signal/:room_id.
func PairRoomID(a, b string) (string, error) {
	enc := func(s string) (string, error) {
		raw, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			return "", fmt.Errorf("decode public key: %w", err)
		}
		return base64.RawURLEncoding.EncodeToString(raw), nil
	}
	ak, err := enc(a)
	if err != nil {
		return "", err
	}
	bk, err := enc(b)
	if err != nil {
		return "", err
	}
	if ak > bk {
		ak, bk = bk, ak
	}
	return "pair:" + ak + "." + bk, nil
}

// ICEOffer holds ICE credentials + candidate list sent from one peer to another.
type ICEOffer struct {
	Ufrag      string   `json:"ufrag"`
	Pwd        string   `json:"pwd"`
	Candidates []string `json:"candidates"`
}

// ICECandidates carries trickled candidates after the initial offer/answer.
type ICECandidates struct {
	Candidates []string `json:"candidates"`
}

// Client manages the daemon's connection to the control plane.
//
// onClose handling: each Run iteration creates a fresh `done` channel and
// passes it through Connect → readLoop. This avoids the race where the
// previous-generation readLoop fires the new generation's onClose callback
// after a reconnect.
type Client struct {
	controlURL string
	// authToken is guarded by tokenMu: the device-credential refresh loop
	// rotates it while WS dials and HTTP requests read it concurrently.
	tokenMu   sync.RWMutex
	authToken string
	publicKey string
	http      *http.Client
	wsMu      sync.RWMutex
	ws        *websocket.Conn
	// I5: protect onSignal — Run() ↔ SetSignalHandler can race once the
	// daemon's main goroutine wires the callback after Run is in flight.
	signalMu sync.RWMutex
	onSignal func(msg SignalMessage)
}

// New creates a new control plane client.
func New(controlURL, authToken, publicKey string) *Client {
	return &Client{
		controlURL: controlURL,
		authToken:  authToken,
		publicKey:  publicKey,
		http:       &http.Client{Timeout: 10 * time.Second},
	}
}

// token returns the current bearer token under lock.
func (c *Client) token() string {
	c.tokenMu.RLock()
	defer c.tokenMu.RUnlock()
	return c.authToken
}

// SetAuthToken swaps the bearer used for subsequent requests. Called by the
// daemon's device-credential refresh loop; in-flight requests keep the token
// they already read.
func (c *Client) SetAuthToken(token string) {
	c.tokenMu.Lock()
	c.authToken = token
	c.tokenMu.Unlock()
}

// SetSignalHandler sets the callback invoked for incoming signaling messages.
func (c *Client) SetSignalHandler(fn func(msg SignalMessage)) {
	c.signalMu.Lock()
	c.onSignal = fn
	c.signalMu.Unlock()
}

// signalHandler returns a snapshot of the current signal callback under lock.
func (c *Client) signalHandler() func(msg SignalMessage) {
	c.signalMu.RLock()
	defer c.signalMu.RUnlock()
	return c.onSignal
}

// Connect establishes the WebSocket connection to the signaling endpoint.
// The roomID should be a deterministic identifier for this peer's signaling room.
// onClose, if non-nil, is invoked exactly once when readLoop for this specific
// connection exits — bound to this connection generation, no cross-talk with
// later reconnects.
func (c *Client) Connect(ctx context.Context, roomID string, onClose func()) error {
	wsURL, err := url.Parse(c.controlURL)
	if err != nil {
		return fmt.Errorf("parse control URL: %w", err)
	}
	wsURL.Scheme = map[string]string{"http": "ws", "https": "wss"}[wsURL.Scheme]
	wsURL.Path = "/api/signal/" + roomID
	q := wsURL.Query()
	q.Set("pk", c.publicKey)
	// SignalDO route requires the JWT in the query string because browsers
	// can't send custom WebSocket headers. Native clients still get an
	// Authorization header below for any non-WS upgrade redirect, but the
	// query param is the load-bearing one.
	if tok := c.token(); tok != "" {
		q.Set("token", tok)
	}
	wsURL.RawQuery = q.Encode()

	ws, _, err := websocket.Dial(ctx, wsURL.String(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.token()}},
	})
	if err != nil {
		return fmt.Errorf("signal WS dial: %w", err)
	}
	c.wsMu.Lock()
	c.ws = ws
	c.wsMu.Unlock()

	go c.readLoop(ctx, ws, onClose)
	return nil
}

// Run keeps the signal connection alive across transient failures.
// It calls Connect; if readLoop exits (control plane restart, network drop),
// it reconnects with exponential backoff capped at 60s. Run blocks until
// ctx is done. Use this instead of bare Connect when you want auto-recovery.
func (c *Client) Run(ctx context.Context, roomID string) {
	const (
		minBackoff = 1 * time.Second
		maxBackoff = 60 * time.Second
	)
	backoff := minBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		done := make(chan struct{})
		// Capture done in this iteration's closure; readLoop only knows about
		// this generation's channel.
		closeOnce := sync.Once{}
		closer := func() { closeOnce.Do(func() { close(done) }) }

		if err := c.Connect(ctx, roomID, closer); err != nil {
			fmt.Printf("[control] connect failed: %v (retry in %s)\n", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = nextBackoff(backoff, maxBackoff)
			continue
		}
		backoff = minBackoff

		select {
		case <-ctx.Done():
			_ = c.Close()
			return
		case <-done:
			fmt.Printf("[control] disconnected, reconnecting in %s\n", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = nextBackoff(backoff, maxBackoff)
		}
	}
}

func nextBackoff(cur, max time.Duration) time.Duration {
	next := cur * 2
	if next > max {
		next = max
	}
	return next
}

// SendSignal sends a signaling message to a specific peer or broadcasts.
func (c *Client) SendSignal(ctx context.Context, msg SignalMessage) error {
	c.wsMu.RLock()
	ws := c.ws
	c.wsMu.RUnlock()
	if ws == nil {
		return fmt.Errorf("not connected to signal server")
	}
	return wsjson.Write(ctx, ws, msg)
}

// InitiateHolePunch sends ICE offer to target peer.
func (c *Client) InitiateHolePunch(ctx context.Context, targetKey string, offer ICEOffer) error {
	payload, _ := json.Marshal(offer)
	return c.SendSignal(ctx, SignalMessage{
		Type:    "offer",
		To:      targetKey,
		Payload: payload,
	})
}

// SendICEAnswer responds to an ICE offer.
func (c *Client) SendICEAnswer(ctx context.Context, targetKey string, answer ICEOffer) error {
	payload, _ := json.Marshal(answer)
	return c.SendSignal(ctx, SignalMessage{
		Type:    "answer",
		To:      targetKey,
		Payload: payload,
	})
}

// SendICECandidate sends additional gathered ICE candidates to a peer.
func (c *Client) SendICECandidate(ctx context.Context, targetKey string, candidates []string) error {
	payload, _ := json.Marshal(ICECandidates{Candidates: candidates})
	return c.SendSignal(ctx, SignalMessage{
		Type:    "candidate",
		To:      targetKey,
		Payload: payload,
	})
}

func (c *Client) readLoop(ctx context.Context, ws *websocket.Conn, onClose func()) {
	defer func() {
		if onClose != nil {
			onClose()
		}
	}()
	for {
		var msg SignalMessage
		if err := wsjson.Read(ctx, ws, &msg); err != nil {
			if ctx.Err() == nil {
				fmt.Printf("[control] read error: %v\n", err)
			}
			return
		}
		if h := c.signalHandler(); h != nil {
			h(msg)
		}
	}
}

// Close closes the WebSocket connection.
func (c *Client) Close() error {
	c.wsMu.Lock()
	ws := c.ws
	c.ws = nil
	c.wsMu.Unlock()
	if ws == nil {
		return nil
	}
	return ws.Close(websocket.StatusNormalClosure, "closing")
}

// PeerConfig is the configuration received from the control plane.
type PeerConfig struct {
	Peers  []RemotePeer `json:"peers"`
	Relays []RelayEntry `json:"relays"`
}

type RemotePeer struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
	IP4       string `json:"ip4"`
	IP6       string `json:"ip6"`
	Name      string `json:"name"`
	LastSeen  int64  `json:"last_seen,omitempty"`
	// DERPNodeKey is the peer's Tailscale DERP node key
	// (tailcfg.NodePublic.String(), "nodekey:..."). It is distinct from the
	// WireGuard public key and is used only by DERP fallback transport.
	DERPNodeKey string `json:"derp_node_key,omitempty"`
	// Endpoint is an optional wg UDP endpoint hint of the form host:port.
	// Set by the control plane when the peer reported one on register
	// (Phase-1 manual / smoke testing). Once per-peer ICE lands the daemons
	// will discover endpoints themselves and this field will be ignored.
	Endpoint string `json:"endpoint,omitempty"`
	// DERPURL and NextHopPublicKey are optional forward-compatible fields for
	// the network-completeness work. Current control responses do not have to
	// send them; daemon status will expose them when present.
	DERPURL          string `json:"derp_url,omitempty"`
	NextHopPublicKey string `json:"next_hop_public_key,omitempty"`
}

type ConnectivityReport struct {
	NetworkID     string  `json:"network_id"`
	PeerPublicKey string  `json:"peer_public_key"`
	Direct        bool    `json:"direct"`
	ICEDirect     bool    `json:"ice_direct"`
	WGReachable   bool    `json:"wg_reachable"`
	Transport     string  `json:"transport,omitempty"`
	RTTMs         float64 `json:"rtt_ms,omitempty"`
	Reason        string  `json:"reason,omitempty"`
	Source        string  `json:"source,omitempty"`
	ReporterEpoch string  `json:"reporter_epoch,omitempty"`
	Seq           uint64  `json:"seq,omitempty"`
	ObservedAt    int64   `json:"observed_at,omitempty"`
	// Path-flap telemetry for this source→peer edge, from the daemon's own
	// per-peer path observer. Lets control record mesh instability and bias
	// next-hop selection away from a churning edge.
	PathTransitions uint64 `json:"path_transitions,omitempty"`
	Flapping        bool   `json:"flapping,omitempty"`
}

type RelayEntry struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
	Region   string `json:"region"`
}

type STUNServer struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Region string `json:"region"`
}

type STUNServersResponse struct {
	Servers []STUNServer `json:"servers"`
	Source  string       `json:"source"`
}

// RegisterRequest is the body sent to POST /api/peers/register.
type RegisterRequest struct {
	PublicKey   string `json:"public_key"`
	Name        string `json:"name"`
	Platform    string `json:"platform"`
	DERPNodeKey string `json:"derp_node_key,omitempty"`
	// WGEndpoint is the daemon's directly-reachable wg UDP endpoint
	// (host:port), used by the smoke / manual mesh until per-peer ICE
	// candidate exchange is implemented. Empty = no hint.
	WGEndpoint string `json:"wg_endpoint,omitempty"`
}

// PeerInfo is what control plane returns about *this* peer after register.
type PeerInfo struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	PublicKey string `json:"public_key"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	IP4       string `json:"ip4"`
	IP6       string `json:"ip6"`
}

// RegisterResponse is the JSON returned by /api/peers/register.
type RegisterResponse struct {
	Peer   PeerInfo `json:"peer"`
	Config string   `json:"config"` // wg-quick formatted config snippet
}

// Register POSTs the daemon's identity to the control plane and receives the
// allocated VPN IPv4/IPv6 plus a wg-quick config preview.
func (c *Client) Register(ctx context.Context, req RegisterRequest) (*RegisterResponse, error) {
	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.controlURL+"/api/peers/register", bytesReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.token())
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("control register: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		return nil, fmt.Errorf("control register: HTTP %d: %s", resp.StatusCode, string(buf[:n]))
	}
	var out RegisterResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("control register decode: %w", err)
	}
	return &out, nil
}

// FetchConfig calls GET /api/peers/config (optionally scoped to room_id) and
// returns the peer mesh and relay entries the daemon should program into wg.
func (c *Client) FetchConfig(ctx context.Context, roomID string) (*PeerConfig, error) {
	u, err := url.Parse(c.controlURL + "/api/peers/config")
	if err != nil {
		return nil, err
	}
	if roomID != "" {
		q := u.Query()
		q.Set("room_id", roomID)
		u.RawQuery = q.Encode()
	}
	httpReq, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.token())
	httpReq.Header.Set("X-Peer-Public-Key", c.publicKey)
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("control fetch-config: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		return nil, fmt.Errorf("control fetch-config: HTTP %d: %s", resp.StatusCode, string(buf[:n]))
	}
	var out PeerConfig
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("control fetch-config decode: %w", err)
	}
	return &out, nil
}

func (c *Client) ReportConnectivity(ctx context.Context, report ConnectivityReport) error {
	body, _ := json.Marshal(report)
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.controlURL+"/api/peers/connectivity", bytesReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.token())
	httpReq.Header.Set("X-Peer-Public-Key", c.publicKey)
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return fmt.Errorf("control report-connectivity: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		return fmt.Errorf("control report-connectivity: HTTP %d: %s", resp.StatusCode, string(buf[:n]))
	}
	return nil
}

// FetchSTUNServers returns STUN host:port entries used by ICE gathering.
func (c *Client) FetchSTUNServers(ctx context.Context) ([]string, error) {
	httpReq, err := http.NewRequestWithContext(ctx, "GET", c.controlURL+"/api/stun/servers", nil)
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+c.token())
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("control fetch-stun: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		return nil, fmt.Errorf("control fetch-stun: HTTP %d: %s", resp.StatusCode, string(buf[:n]))
	}
	var out STUNServersResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("control fetch-stun decode: %w", err)
	}
	servers := make([]string, 0, len(out.Servers))
	for _, s := range out.Servers {
		if s.Host == "" {
			continue
		}
		port := s.Port
		if port == 0 {
			port = 3478
		}
		servers = append(servers, fmt.Sprintf("%s:%d", s.Host, port))
	}
	return servers, nil
}

// bytesReader returns an io.Reader for body bodies that ALSO implements io.Seeker
// and a Len() method, so net/http will detect the body size and emit a proper
// Content-Length header instead of falling back to chunked transfer encoding
// (which some HTTP/1.0 servers — including Python BaseHTTPServer used by our
// e2e mock control plane — do not support and will hang on indefinitely).
// DeviceTokenResponse is the control plane's answer to a device-credential
// exchange: a short-lived user JWT plus its expiry.
type DeviceTokenResponse struct {
	Token     string `json:"token"`
	UserID    string `json:"user_id"`
	ExpiresAt int64  `json:"expires_at"`
}

// ExchangeDeviceToken trades a long-lived device credential (dt_…) for a
// short-lived user JWT. Unauthenticated by design — the credential is the
// proof. The caller decides whether to install the result via SetAuthToken.
func (c *Client) ExchangeDeviceToken(ctx context.Context, deviceToken string) (*DeviceTokenResponse, error) {
	body, _ := json.Marshal(map[string]string{"device_token": deviceToken})
	httpReq, err := http.NewRequestWithContext(ctx, "POST", c.controlURL+"/api/auth/device", bytesReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("control device-token exchange: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		return nil, fmt.Errorf("control device-token exchange: HTTP %d: %s", resp.StatusCode, string(buf[:n]))
	}
	var out DeviceTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("control device-token exchange: decode: %w", err)
	}
	if out.Token == "" {
		return nil, fmt.Errorf("control device-token exchange: empty token in response")
	}
	return &out, nil
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
