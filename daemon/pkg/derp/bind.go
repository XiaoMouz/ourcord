package derp

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"syscall"

	"golang.zx2c4.com/wireguard/conn"
)

// HybridBind wraps WireGuard's native UDP bind and adds DERP endpoints. Native
// UDP stays the fast path; DERP endpoints are used for relay-first bootstrap
// and fallback.
type HybridBind struct {
	native conn.Bind
	mgr    *Manager

	mu     sync.Mutex
	closed bool
	done   chan struct{}
}

var _ conn.Bind = (*HybridBind)(nil)

func NewHybridBind(native conn.Bind, mgr *Manager) *HybridBind {
	return &HybridBind{native: native, mgr: mgr, done: make(chan struct{})}
}

func (b *HybridBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := b.native.Open(port)
	if err != nil {
		return nil, 0, err
	}
	b.mu.Lock()
	if b.closed {
		b.closed = false
		b.done = make(chan struct{})
	}
	b.mu.Unlock()
	if b.mgr != nil {
		fns = append(fns, b.receiveDERP)
	}
	return fns, actual, nil
}

func (b *HybridBind) Close() error {
	b.mu.Lock()
	if !b.closed {
		b.closed = true
		close(b.done)
	}
	b.mu.Unlock()
	return b.native.Close()
}

func (b *HybridBind) SetMark(mark uint32) error { return b.native.SetMark(mark) }
func (b *HybridBind) BatchSize() int            { return b.native.BatchSize() }

func (b *HybridBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	if ep, err := ParseEndpointString(s); err == nil {
		return ep, nil
	}
	return b.native.ParseEndpoint(s)
}

func (b *HybridBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	if dep, ok := ep.(*Endpoint); ok {
		if b.mgr == nil {
			return errors.New("derp endpoint configured but derp manager is nil")
		}
		ctx := context.Background()
		for _, buf := range bufs {
			if len(buf) == 0 {
				continue
			}
			if err := b.mgr.Send(ctx, dep.RelayURL, dep.NodeKey, buf); err != nil {
				return err
			}
		}
		return nil
	}
	return b.native.Send(bufs, ep)
}

func (b *HybridBind) receiveDERP(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
	b.mu.Lock()
	closed := b.closed
	b.mu.Unlock()
	if closed {
		return 0, net.ErrClosed
	}
	var p Packet
	select {
	case <-b.done:
		return 0, net.ErrClosed
	case p = <-b.mgr.Recv():
	}
	if len(packets) == 0 || len(sizes) == 0 || len(eps) == 0 {
		return 0, fmt.Errorf("derp receive called with empty buffers")
	}
	if len(p.Data) > len(packets[0]) {
		return 0, syscall.EMSGSIZE
	}
	copy(packets[0], p.Data)
	sizes[0] = len(p.Data)
	eps[0] = &Endpoint{RelayURL: p.RelayURL, NodeKey: p.Source}
	return 1, nil
}
