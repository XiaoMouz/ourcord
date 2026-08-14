package ice

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/control"
)

type retrySignalClient struct {
	mu     sync.Mutex
	offers int
}

func (*retrySignalClient) SetSignalHandler(func(control.SignalMessage)) {}

func (c *retrySignalClient) InitiateHolePunch(context.Context, string, control.ICEOffer) error {
	c.mu.Lock()
	c.offers++
	c.mu.Unlock()
	return errors.New("signal websocket not connected")
}

func (*retrySignalClient) SendICEAnswer(context.Context, string, control.ICEOffer) error {
	return nil
}

func (*retrySignalClient) SendICECandidate(context.Context, string, []string) error {
	return nil
}

func (c *retrySignalClient) offerCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.offers
}

func TestStartPeerRetriesOfferAfterSignalingRace(t *testing.T) {
	signal := &retrySignalClient{}
	m := NewManager("z-local", nil, signal, nil, nil, t.Logf)
	t.Cleanup(func() { _ = m.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m.StartPeer(ctx, "a-peer")
	waitOfferCount(t, ctx, signal, 1)

	// A later SignalDO join/paired event calls StartPeer again. The existing
	// session must re-use its candidates and retry the offer instead of treating
	// session existence as proof that signaling succeeded.
	m.StartPeer(ctx, "a-peer")
	waitOfferCount(t, ctx, signal, 2)
}

func waitOfferCount(t *testing.T, ctx context.Context, signal *retrySignalClient, want int) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if signal.offerCount() >= want {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("offer count = %d, want at least %d", signal.offerCount(), want)
		case <-ticker.C:
		}
	}
}

func TestPeerRTTMsDistinguishesUnknownFromMeasured(t *testing.T) {
	m := NewManager("local", nil, &retrySignalClient{}, nil, nil, t.Logf)
	m.sessions["peer"] = &session{peerKey: "peer", rttMs: 18.75}
	if got := m.PeerRTTMs("peer"); got != 18.75 {
		t.Fatalf("PeerRTTMs = %v, want 18.75", got)
	}
	if got := m.PeerRTTMs("missing"); got != 0 {
		t.Fatalf("missing PeerRTTMs = %v, want unknown zero", got)
	}
}
