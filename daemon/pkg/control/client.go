// Package control implements the daemon's WebSocket connection to the OurCord control plane.
// Handles peer registration, config fetching, and hole-punching signal exchange.
package control

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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
type Client struct {
	controlURL  string
	authToken   string
	publicKey   string
	ws          *websocket.Conn
	onSignal    func(msg SignalMessage)
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
	c.onSignal = fn
}

// Connect establishes the WebSocket connection to the signaling endpoint.
// The roomID should be a deterministic identifier for this peer's signaling room.
func (c *Client) Connect(ctx context.Context, roomID string) error {
	wsURL, err := url.Parse(c.controlURL)
	if err != nil {
		return fmt.Errorf("parse control URL: %w", err)
	}
	wsURL.Scheme = map[string]string{"http": "ws", "https": "wss"}[wsURL.Scheme]
	wsURL.Path = "/api/signal/" + roomID
	q := wsURL.Query()
	q.Set("pk", c.publicKey)
	wsURL.RawQuery = q.Encode()

	ws, _, err := websocket.Dial(ctx, wsURL.String(), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.authToken}},
	})
	if err != nil {
		return fmt.Errorf("signal WS dial: %w", err)
	}
	c.ws = ws

	go c.readLoop(ctx)
	return nil
}

// SendSignal sends a signaling message to a specific peer or broadcasts.
func (c *Client) SendSignal(ctx context.Context, msg SignalMessage) error {
	if c.ws == nil {
		return fmt.Errorf("not connected to signal server")
	}
	return wsjson.Write(ctx, c.ws, msg)
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

func (c *Client) readLoop(ctx context.Context) {
	for {
		var msg SignalMessage
		if err := wsjson.Read(ctx, c.ws, &msg); err != nil {
			if ctx.Err() != nil {
				return
			}
			fmt.Printf("[control] read error: %v, reconnecting in 5s\n", err)
			time.Sleep(5 * time.Second)
			return // caller should reconnect
		}
		if c.onSignal != nil {
			c.onSignal(msg)
		}
	}
}

// Close closes the WebSocket connection.
func (c *Client) Close() error {
	if c.ws == nil {
		return nil
	}
	return c.ws.Close(websocket.StatusNormalClosure, "closing")
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
