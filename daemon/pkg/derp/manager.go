package derp

import (
	"context"
	"fmt"
	"log"
	"sync"

	tsderp "tailscale.com/derp"
	"tailscale.com/derp/derphttp"
	"tailscale.com/net/netmon"
	"tailscale.com/types/key"
)

type Packet struct {
	Source   string
	RelayURL string
	Data     []byte
}

type Manager struct {
	priv key.NodePrivate
	logf func(format string, args ...any)

	mu      sync.Mutex
	clients map[string]*derphttp.Client
	recvCh  chan Packet
}

func NewManager(priv key.NodePrivate, logf func(format string, args ...any)) *Manager {
	if logf == nil {
		logf = log.Printf
	}
	return &Manager{
		priv:    priv,
		logf:    logf,
		clients: make(map[string]*derphttp.Client),
		recvCh:  make(chan Packet, 1024),
	}
}

func (m *Manager) PublicKeyString() string {
	return m.priv.Public().String()
}

func (m *Manager) Recv() <-chan Packet {
	return m.recvCh
}

func (m *Manager) Send(ctx context.Context, relayURL, dstNodeKey string, pkt []byte) error {
	if relayURL == "" {
		return fmt.Errorf("derp relay URL required")
	}
	dst, err := parseNodePublic(dstNodeKey)
	if err != nil {
		return err
	}
	c, err := m.client(ctx, relayURL)
	if err != nil {
		return err
	}
	return c.Send(dst, pkt)
}

func (m *Manager) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for url, c := range m.clients {
		c.Close()
		delete(m.clients, url)
	}
	return nil
}

func (m *Manager) client(ctx context.Context, relayURL string) (*derphttp.Client, error) {
	m.mu.Lock()
	if c := m.clients[relayURL]; c != nil {
		m.mu.Unlock()
		return c, nil
	}
	c, err := derphttp.NewClient(m.priv, relayURL, m.logf, netmon.NewStatic())
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	m.clients[relayURL] = c
	m.mu.Unlock()
	if err := c.Connect(ctx); err != nil {
		return nil, err
	}
	go m.recvLoop(relayURL, c)
	return c, nil
}

func (m *Manager) recvLoop(relayURL string, c *derphttp.Client) {
	for {
		msg, err := c.Recv()
		if err != nil {
			m.logf("derp recv %s: %v", relayURL, err)
			return
		}
		switch v := msg.(type) {
		case tsderp.ReceivedPacket:
			data := make([]byte, len(v.Data))
			copy(data, v.Data)
			select {
			case m.recvCh <- Packet{Source: v.Source.String(), RelayURL: relayURL, Data: data}:
			default:
				m.logf("derp recv queue full; dropping packet from %s", v.Source.ShortString())
			}
		}
	}
}

func parseNodePublic(s string) (key.NodePublic, error) {
	var pub key.NodePublic
	if err := pub.UnmarshalText([]byte(s)); err != nil {
		return key.NodePublic{}, fmt.Errorf("parse derp node key %q: %w", s, err)
	}
	return pub, nil
}
