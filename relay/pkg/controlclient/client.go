// Package controlclient handles synchronization with the OurCord control plane.
// It fetches the banned key list periodically and provides a fast lookup.
package controlclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// BanList holds the set of banned WireGuard public keys (base64 encoded).
type BanList struct {
	mu   sync.RWMutex
	keys map[string]struct{}
}

func (b *BanList) IsBanned(publicKey string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	_, ok := b.keys[publicKey]
	return ok
}

func (b *BanList) Replace(keys []string) {
	m := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		m[k] = struct{}{}
	}
	b.mu.Lock()
	b.keys = m
	b.mu.Unlock()
}

// Identity describes how this relay reports itself to the control plane.
// All fields are required by the control layer's /api/relay/register endpoint
// (see control/src/relay.ts).
type Identity struct {
	Region       string // e.g. "cn-east"
	Hostname     string // public hostname clients connect to
	Port         int    // public TCP port (defaults to 443 if zero)
	Mode         string // "personal" | "lobby" | "rental"
	CapacityKbps int    // soft capacity hint
}

// Client communicates with the control plane to register the relay server
// and keep the banned key list up to date.
type Client struct {
	controlURL string
	authToken  string
	relayID    atomic.Pointer[string] // mutable so first registration can fill it in
	identity   Identity
	banList    *BanList
	httpClient *http.Client
	connCount   atomic.Int64 // current open connections; incremented externally
	bytesPerSec atomic.Int64 // last computed throughput; updated by SetBytesPerSec
	onRegister  func(id string)
}

// New creates a new control plane client.
// If relayID is empty the first heartbeat will register and remember the
// returned ID for subsequent heartbeats.
func New(controlURL, authToken, relayID string, identity Identity) *Client {
	c := &Client{
		controlURL: controlURL,
		authToken:  authToken,
		identity:   identity,
		banList:    &BanList{keys: make(map[string]struct{})},
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
	if relayID != "" {
		c.relayID.Store(&relayID)
	}
	return c
}

// BanList returns the live ban list.
func (c *Client) BanList() *BanList { return c.banList }

// IncConn / DecConn track current connection count for heartbeat reporting.
func (c *Client) IncConn() { c.connCount.Add(1) }
func (c *Client) DecConn() { c.connCount.Add(-1) }

// SetBytesPerSec updates the throughput sample reported on the next heartbeat.
// The relay's limiter accounting layer (or a periodic sampler) is expected to
// call this; if never called, heartbeats report 0 and the relay is treated as
// fully idle for ranking purposes.
func (c *Client) SetBytesPerSec(v int64) { c.bytesPerSec.Store(v) }

// OnRegister registers a callback fired exactly once when the control plane
// first issues a relay ID. Used by the relay binary to persist the ID so
// subsequent restarts reuse the same relay_servers row instead of creating
// a duplicate. Setting it after Run() has already registered is a no-op.
func (c *Client) OnRegister(fn func(id string)) { c.onRegister = fn }

// RelayID returns the currently known relay ID, or "" before registration.
func (c *Client) RelayID() string {
	if p := c.relayID.Load(); p != nil {
		return *p
	}
	return ""
}

// Run starts the background sync loop. It fetches banned keys every syncInterval
// and sends heartbeats every heartbeatInterval.
func (c *Client) Run(ctx context.Context, syncInterval, heartbeatInterval time.Duration) {
	syncTicker := time.NewTicker(syncInterval)
	heartbeatTicker := time.NewTicker(heartbeatInterval)
	defer syncTicker.Stop()
	defer heartbeatTicker.Stop()

	// Initial fetch
	if err := c.syncBannedKeys(ctx); err != nil {
		fmt.Printf("[controlclient] initial ban sync failed: %v\n", err)
	}
	if err := c.sendHeartbeat(ctx); err != nil {
		fmt.Printf("[controlclient] initial heartbeat failed: %v\n", err)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-syncTicker.C:
			if err := c.syncBannedKeys(ctx); err != nil {
				fmt.Printf("[controlclient] ban sync failed: %v\n", err)
			}
		case <-heartbeatTicker.C:
			if err := c.sendHeartbeat(ctx); err != nil {
				fmt.Printf("[controlclient] heartbeat failed: %v\n", err)
			}
		}
	}
}

func (c *Client) syncBannedKeys(ctx context.Context) error {
	urlStr := c.controlURL + "/api/relay/banned-keys"
	if idPtr := c.relayID.Load(); idPtr != nil && *idPtr != "" {
		urlStr += "?relay_id=" + *idPtr
	}
	req, err := http.NewRequestWithContext(ctx, "GET", urlStr, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	var result struct {
		Keys []string `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}

	c.banList.Replace(result.Keys)
	return nil
}

// heartbeatPayload mirrors what control/src/relay.ts expects on
// POST /api/relay/register. Both new registration and heartbeat-update use
// the same shape; presence of "id" switches to update mode server-side.
//
// ActiveConns / BytesPerSec are persisted into the relay_load table and used
// by /api/relay/map to rank relays by available headroom.
type heartbeatPayload struct {
	ID           string `json:"id,omitempty"`
	Region       string `json:"region"`
	Hostname     string `json:"hostname"`
	Port         int    `json:"port,omitempty"`
	Mode         string `json:"mode"`
	CapacityKbps int    `json:"capacity_kbps,omitempty"`
	ActiveConns  int64  `json:"active_conns"`
	BytesPerSec  int64  `json:"bytes_per_sec"`
}

func (c *Client) sendHeartbeat(ctx context.Context) error {
	if c.identity.Hostname == "" || c.identity.Region == "" || c.identity.Mode == "" {
		return fmt.Errorf("incomplete identity (need region, hostname, mode)")
	}

	payload := heartbeatPayload{
		Region:       c.identity.Region,
		Hostname:     c.identity.Hostname,
		Port:         c.identity.Port,
		Mode:         c.identity.Mode,
		CapacityKbps: c.identity.CapacityKbps,
		ActiveConns:  c.connCount.Load(),
		BytesPerSec:  c.bytesPerSec.Load(),
	}
	if idPtr := c.relayID.Load(); idPtr != nil {
		payload.ID = *idPtr
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", c.controlURL+"/api/relay/register",
		bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.authToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("heartbeat HTTP %d", resp.StatusCode)
	}

	// On first registration the server returns {"id": "..."}; remember it.
	if payload.ID == "" {
		var reply struct {
			ID string `json:"id"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&reply); err == nil && reply.ID != "" {
			c.relayID.Store(&reply.ID)
			fmt.Printf("[controlclient] registered as relay %s\n", reply.ID)
			if c.onRegister != nil {
				c.onRegister(reply.ID)
			}
		}
	}
	return nil
}
