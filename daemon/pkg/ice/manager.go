package ice

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/control"
	pionice "github.com/pion/ice/v4"
)

type SignalClient interface {
	SetSignalHandler(func(control.SignalMessage))
	InitiateHolePunch(context.Context, string, control.ICEOffer) error
	SendICEAnswer(context.Context, string, control.ICEOffer) error
	SendICECandidate(context.Context, string, []string) error
}

type Packet struct {
	PeerPublicKey string
	Data          []byte
}

type Manager struct {
	localKey    string
	stunServers []string
	signal      SignalClient
	onReady     func(peerPublicKey string)
	logf        func(format string, args ...any)

	mu       sync.Mutex
	sessions map[string]*session
	recvCh   chan Packet
	doneCh   chan struct{}
	closed   bool
}

type session struct {
	peerKey         string
	agent           *Agent
	conn            *pionice.Conn
	controlling     bool
	dialing         bool
	gatherOnce      sync.Once
	gatherCloseOnce sync.Once
	gatherDone      chan struct{}
	localCandidates []string
}

func NewManager(localKey string, stunServers []string, signal SignalClient, onReady func(peerPublicKey string), logf func(format string, args ...any)) *Manager {
	if logf == nil {
		logf = log.Printf
	}
	return &Manager{
		localKey:    localKey,
		stunServers: ParseSTUNURLs(stunServers),
		signal:      signal,
		onReady:     onReady,
		logf:        logf,
		sessions:    make(map[string]*session),
		recvCh:      make(chan Packet, 1024),
		doneCh:      make(chan struct{}),
	}
}

func (m *Manager) Recv() <-chan Packet {
	return m.recvCh
}

func (m *Manager) Done() <-chan struct{} {
	return m.doneCh
}

func (m *Manager) StartPeer(ctx context.Context, peerKey string) {
	if peerKey == "" || peerKey == m.localKey {
		return
	}
	controlling := m.localKey > peerKey
	s, _, err := m.ensureSession(peerKey, controlling)
	if err != nil {
		m.logf("ice session %s: %v", shortKey(peerKey), err)
		return
	}
	if !controlling {
		return
	}
	go m.sendOffer(ctx, s)
}

func (m *Manager) HandleSignal(msg control.SignalMessage) {
	switch msg.Type {
	case "join", "paired":
		for _, peer := range msg.Peers {
			m.StartPeer(context.Background(), peer)
		}
	case "offer":
		if msg.From == "" || msg.From == m.localKey {
			return
		}
		var offer control.ICEOffer
		if err := json.Unmarshal(msg.Payload, &offer); err != nil {
			m.logf("ice offer from %s: %v", shortKey(msg.From), err)
			return
		}
		go m.handleOffer(msg.From, offer)
	case "answer":
		if msg.From == "" || msg.From == m.localKey {
			return
		}
		var answer control.ICEOffer
		if err := json.Unmarshal(msg.Payload, &answer); err != nil {
			m.logf("ice answer from %s: %v", shortKey(msg.From), err)
			return
		}
		go m.handleAnswer(msg.From, answer)
	case "candidate":
		if msg.From == "" || msg.From == m.localKey {
			return
		}
		var c control.ICECandidates
		if err := json.Unmarshal(msg.Payload, &c); err != nil {
			m.logf("ice candidate from %s: %v", shortKey(msg.From), err)
			return
		}
		m.addRemoteCandidates(msg.From, c.Candidates)
	}
}

func (m *Manager) Send(peerKey string, pkt []byte) error {
	m.mu.Lock()
	s := m.sessions[peerKey]
	var c *pionice.Conn
	if s != nil {
		c = s.conn
	}
	m.mu.Unlock()
	if c == nil {
		return fmt.Errorf("ice peer %s not connected", shortKey(peerKey))
	}
	_, err := c.Write(pkt)
	return err
}

func (m *Manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	sessions := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*session)
	close(m.doneCh)
	m.mu.Unlock()
	for _, s := range sessions {
		if s.conn != nil {
			_ = s.conn.Close()
			continue
		}
		if s.agent != nil {
			_ = s.agent.Close()
		}
	}
	return nil
}

func (m *Manager) ensureSession(peerKey string, controlling bool) (*session, bool, error) {
	m.mu.Lock()
	if s := m.sessions[peerKey]; s != nil {
		m.mu.Unlock()
		return s, false, nil
	}
	m.mu.Unlock()

	var s *session
	a, err := NewAgent(Config{
		STUNServers: m.stunServers,
		OnCandidates: func(candidates []string) {
			if s == nil {
				return
			}
			m.mu.Lock()
			s.localCandidates = append([]string(nil), candidates...)
			m.mu.Unlock()
			s.gatherCloseOnce.Do(func() { close(s.gatherDone) })
			if len(candidates) == 0 {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := m.signal.SendICECandidate(ctx, s.peerKey, candidates); err != nil {
				m.logf("ice send candidates to %s: %v", shortKey(s.peerKey), err)
			}
		},
	})
	if err != nil {
		return nil, false, err
	}
	s = &session{peerKey: peerKey, agent: a, controlling: controlling, gatherDone: make(chan struct{})}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		_ = a.Close()
		return nil, false, fmt.Errorf("ice manager closed")
	}
	if existing := m.sessions[peerKey]; existing != nil {
		_ = a.Close()
		return existing, false, nil
	}
	m.sessions[peerKey] = s
	return s, true, nil
}

func (m *Manager) sendOffer(ctx context.Context, s *session) {
	ufrag, pwd, err := s.agent.Credentials()
	if err != nil {
		m.logf("ice credentials for %s: %v", shortKey(s.peerKey), err)
		return
	}
	candidates := m.gatherLocal(ctx, s)
	offer := control.ICEOffer{Ufrag: ufrag, Pwd: pwd, Candidates: candidates}
	sendCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := m.signal.InitiateHolePunch(sendCtx, s.peerKey, offer); err != nil {
		m.logf("ice send offer to %s: %v", shortKey(s.peerKey), err)
	}
}

func (m *Manager) gatherLocal(ctx context.Context, s *session) []string {
	s.gatherOnce.Do(func() {
		if err := s.agent.GatherCandidates(); err != nil {
			m.logf("ice gather for %s: %v", shortKey(s.peerKey), err)
			s.gatherCloseOnce.Do(func() { close(s.gatherDone) })
		}
	})
	waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	select {
	case <-s.gatherDone:
	case <-waitCtx.Done():
		m.logf("ice gather timeout for %s: %v", shortKey(s.peerKey), waitCtx.Err())
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), s.localCandidates...)
}

func (m *Manager) handleOffer(peerKey string, offer control.ICEOffer) {
	s, _, err := m.ensureSession(peerKey, false)
	if err != nil {
		m.logf("ice accept session %s: %v", shortKey(peerKey), err)
		return
	}
	m.addRemoteCandidates(peerKey, offer.Candidates)
	ufrag, pwd, err := s.agent.Credentials()
	if err != nil {
		m.logf("ice answer credentials for %s: %v", shortKey(peerKey), err)
		return
	}
	candidates := m.gatherLocal(context.Background(), s)
	answer := control.ICEOffer{Ufrag: ufrag, Pwd: pwd, Candidates: candidates}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := m.signal.SendICEAnswer(ctx, peerKey, answer); err != nil {
		m.logf("ice send answer to %s: %v", shortKey(peerKey), err)
	}
	cancel()
	conn, err := s.agent.Accept(context.Background(), offer.Ufrag, offer.Pwd)
	if err != nil {
		m.logf("ice accept %s: %v", shortKey(peerKey), err)
		return
	}
	m.setConn(peerKey, conn)
}

func (m *Manager) handleAnswer(peerKey string, answer control.ICEOffer) {
	m.mu.Lock()
	s := m.sessions[peerKey]
	if s == nil || s.dialing || s.conn != nil {
		m.mu.Unlock()
		return
	}
	s.dialing = true
	m.mu.Unlock()
	m.addRemoteCandidates(peerKey, answer.Candidates)
	conn, err := s.agent.Dial(context.Background(), answer.Ufrag, answer.Pwd)
	if err != nil {
		m.logf("ice dial %s: %v", shortKey(peerKey), err)
		return
	}
	m.setConn(peerKey, conn)
}

func (m *Manager) addRemoteCandidates(peerKey string, candidates []string) {
	if len(candidates) == 0 {
		return
	}
	m.mu.Lock()
	s := m.sessions[peerKey]
	m.mu.Unlock()
	if s == nil {
		return
	}
	for _, c := range candidates {
		if err := s.agent.AddRemoteCandidate(c); err != nil {
			m.logf("ice candidate %s: %v", shortKey(peerKey), err)
		}
	}
}

func (m *Manager) setConn(peerKey string, c *pionice.Conn) {
	m.mu.Lock()
	s := m.sessions[peerKey]
	if s == nil {
		m.mu.Unlock()
		_ = c.Close()
		return
	}
	if s.conn != nil {
		old := s.conn
		s.conn = c
		m.mu.Unlock()
		_ = old.Close()
	} else {
		s.conn = c
		m.mu.Unlock()
	}
	m.logf("ice connected peer=%s local=%v remote=%v", shortKey(peerKey), c.LocalAddr(), c.RemoteAddr())
	if m.onReady != nil {
		m.onReady(peerKey)
	}
	go m.recvLoop(peerKey, c)
}

func (m *Manager) recvLoop(peerKey string, c *pionice.Conn) {
	buf := make([]byte, 65535)
	for {
		n, err := c.Read(buf)
		if err != nil {
			m.logf("ice recv %s: %v", shortKey(peerKey), err)
			return
		}
		pkt := make([]byte, n)
		copy(pkt, buf[:n])
		m.mu.Lock()
		closed := m.closed
		m.mu.Unlock()
		if closed {
			return
		}
		select {
		case m.recvCh <- Packet{PeerPublicKey: peerKey, Data: pkt}:
		default:
			m.logf("ice recv queue full; dropping packet from %s", shortKey(peerKey))
		}
	}
}

func shortKey(s string) string {
	if len(s) <= 12 {
		return s
	}
	return s[:12]
}
