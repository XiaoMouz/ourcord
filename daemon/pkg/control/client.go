// Package control implements the daemon's WebSocket connection to the OurCord control plane.
// Handles peer registration, config fetching, and hole-punching signal exchange.
package control

import (
	"context"
	"encoding/json"
	"fmt"
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
}

// ICEOffer holds ICE credentials + candidate list sent from one peer to another.
type ICEOffer struct {
	Ufrag      string   `json:"ufrag"`
	Pwd        string   `json:"pwd"`
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
	authToken  string
	publicKey  string
	wsMu       sync.RWMutex
	ws         *websocket.Conn
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
	}
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
	if c.authToken != "" {
		q.Set("token", c.authToken)
	}
	wsURL.RawQuery = q.Encode()

	ws, _, err := websocket.Dial(ctx, wsURL.String(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.authToken}},
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
	Peers  []RemotePeer  `json:"peers"`
	Relays []RelayEntry  `json:"relays"`
}

type RemotePeer struct {
	ID        string `json:"id"`
	PublicKey string `json:"public_key"`
	IP4       string `json:"ip4"`
	IP6       string `json:"ip6"`
	Name      string `json:"name"`
}

type RelayEntry struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
	Region   string `json:"region"`
}
