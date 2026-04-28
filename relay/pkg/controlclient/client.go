// Package controlclient handles synchronization with the OurCord control plane.
// It fetches the banned key list periodically and provides a fast lookup.
package controlclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
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

// Client communicates with the control plane to register the relay server
// and keep the banned key list up to date.
type Client struct {
	controlURL string
	authToken  string
	relayID    string
	banList    *BanList
	httpClient *http.Client
}

// New creates a new control plane client.
func New(controlURL, authToken, relayID string) *Client {
	return &Client{
		controlURL: controlURL,
		authToken:  authToken,
		relayID:    relayID,
		banList:    &BanList{keys: make(map[string]struct{})},
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// BanList returns the live ban list.
func (c *Client) BanList() *BanList { return c.banList }

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
	req, err := http.NewRequestWithContext(ctx, "GET", c.controlURL+"/api/relay/banned-keys", nil)
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

func (c *Client) sendHeartbeat(ctx context.Context) error {
	if c.relayID == "" {
		return nil // no relay ID set, skip heartbeat
	}
	body := fmt.Sprintf(`{"id":%q}`, c.relayID)
	req, err := http.NewRequestWithContext(ctx, "POST", c.controlURL+"/api/relay/register",
		strings.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.authToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
