package derp

import (
	"context"
	"fmt"
	"log"
	"sync"
	"sync/atomic"

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

type Stats struct {
	SentPackets       uint64
	RecvPackets       uint64
	RecvQueueDrops    uint64
	SuppressedPackets uint64
	SendErrors        uint64
	RecvErrors        uint64
	MaxPacketBytes    uint64
}

type Manager struct {
	priv key.NodePrivate
	logf func(format string, args ...any)

	mu         sync.Mutex
	clients    map[string]*derphttp.Client
	suppressed map[string]bool
	recvCh     chan Packet

	sentPackets       atomic.Uint64
	recvPackets       atomic.Uint64
	recvQueueDrops    atomic.Uint64
	suppressedPackets atomic.Uint64
	sendErrors        atomic.Uint64
	recvErrors        atomic.Uint64
	maxPacketBytes    atomic.Uint64
}

func NewManager(priv key.NodePrivate, logf func(format string, args ...any)) *Manager {
	if logf == nil {
		logf = log.Printf
	}
	return &Manager{
		priv:       priv,
		logf:       logf,
		clients:    make(map[string]*derphttp.Client),
		suppressed: make(map[string]bool),
		recvCh:     make(chan Packet, 1024),
	}
}

func (m *Manager) PublicKeyString() string {
	return m.priv.Public().String()
}

func (m *Manager) Recv() <-chan Packet {
	return m.recvCh
}

func (m *Manager) Stats() Stats {
	return Stats{
		SentPackets:       m.sentPackets.Load(),
		RecvPackets:       m.recvPackets.Load(),
		RecvQueueDrops:    m.recvQueueDrops.Load(),
		SuppressedPackets: m.suppressedPackets.Load(),
		SendErrors:        m.sendErrors.Load(),
		RecvErrors:        m.recvErrors.Load(),
		MaxPacketBytes:    m.maxPacketBytes.Load(),
	}
}

func (m *Manager) SetSuppressed(nodeKey string, suppressed bool) {
	if nodeKey == "" {
		return
	}
	m.mu.Lock()
	if suppressed {
		m.suppressed[nodeKey] = true
	} else {
		delete(m.suppressed, nodeKey)
	}
	m.mu.Unlock()
}

func (m *Manager) Send(ctx context.Context, relayURL, dstNodeKey string, pkt []byte) error {
	if relayURL == "" {
		m.sendErrors.Add(1)
		return fmt.Errorf("derp relay URL required")
	}
	dst, err := parseNodePublic(dstNodeKey)
	if err != nil {
		m.sendErrors.Add(1)
		return err
	}
	c, err := m.client(ctx, relayURL)
	if err != nil {
		m.sendErrors.Add(1)
		return err
	}
	if err := c.Send(dst, pkt); err != nil {
		m.sendErrors.Add(1)
		return err
	}
	m.sentPackets.Add(1)
	trackMax(&m.maxPacketBytes, len(pkt))
	return nil
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
		m.mu.Lock()
		if m.clients[relayURL] == c {
			delete(m.clients, relayURL)
		}
		m.mu.Unlock()
		c.Close()
		return nil, err
	}
	go m.recvLoop(relayURL, c)
	return c, nil
}

func (m *Manager) recvLoop(relayURL string, c *derphttp.Client) {
	for {
		msg, err := c.Recv()
		if err != nil {
			m.recvErrors.Add(1)
			m.logf("derp recv %s: %v", relayURL, err)
			return
		}
		switch v := msg.(type) {
		case tsderp.ReceivedPacket:
			source := v.Source.String()
			m.mu.Lock()
			suppressed := m.suppressed[source]
			m.mu.Unlock()
			if suppressed {
				m.suppressedPackets.Add(1)
				continue
			}
			data := make([]byte, len(v.Data))
			copy(data, v.Data)
			trackMax(&m.maxPacketBytes, len(data))
			select {
			case m.recvCh <- Packet{Source: source, RelayURL: relayURL, Data: data}:
				m.recvPackets.Add(1)
			default:
				m.recvQueueDrops.Add(1)
				m.logf("derp recv queue full; dropping packet from %s", v.Source.ShortString())
			}
		}
	}
}

func trackMax(v *atomic.Uint64, n int) {
	if n <= 0 {
		return
	}
	next := uint64(n)
	for {
		cur := v.Load()
		if next <= cur || v.CompareAndSwap(cur, next) {
			return
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
