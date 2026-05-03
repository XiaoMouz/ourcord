package ice

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"syscall"

	"golang.zx2c4.com/wireguard/conn"
)

// Bind wraps WireGuard's native UDP bind with ICE endpoints. Native UDP is
// still available; ICE endpoints are selected only after signaling succeeds.
type Bind struct {
	native conn.Bind
	mgr    *Manager

	mu     sync.Mutex
	closed bool
}

var _ conn.Bind = (*Bind)(nil)

func NewBind(native conn.Bind, mgr *Manager) *Bind {
	return &Bind{native: native, mgr: mgr}
}

func (b *Bind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	fns, actual, err := b.native.Open(port)
	if err != nil {
		return nil, 0, err
	}
	if b.mgr != nil {
		fns = append(fns, b.receiveICE)
	}
	return fns, actual, nil
}

func (b *Bind) Close() error {
	b.mu.Lock()
	b.closed = true
	b.mu.Unlock()
	err := b.native.Close()
	if b.mgr != nil {
		_ = b.mgr.Close()
	}
	return err
}

func (b *Bind) SetMark(mark uint32) error { return b.native.SetMark(mark) }
func (b *Bind) BatchSize() int            { return b.native.BatchSize() }

func (b *Bind) ParseEndpoint(s string) (conn.Endpoint, error) {
	if ep, err := ParseEndpointString(s); err == nil {
		return ep, nil
	}
	return b.native.ParseEndpoint(s)
}

func (b *Bind) Send(bufs [][]byte, ep conn.Endpoint) error {
	if iep, ok := ep.(*Endpoint); ok {
		if b.mgr == nil {
			return errors.New("ice endpoint configured but ice manager is nil")
		}
		for _, buf := range bufs {
			if len(buf) == 0 {
				continue
			}
			if err := b.mgr.Send(iep.PeerPublicKey, buf); err != nil {
				return err
			}
		}
		return nil
	}
	return b.native.Send(bufs, ep)
}

func (b *Bind) receiveICE(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
	b.mu.Lock()
	closed := b.closed
	b.mu.Unlock()
	if closed {
		return 0, net.ErrClosed
	}
	var p Packet
	select {
	case <-b.mgr.Done():
		return 0, net.ErrClosed
	case p = <-b.mgr.Recv():
	}
	if len(packets) == 0 || len(sizes) == 0 || len(eps) == 0 {
		return 0, fmt.Errorf("ice receive called with empty buffers")
	}
	if len(p.Data) > len(packets[0]) {
		return 0, syscall.EMSGSIZE
	}
	copy(packets[0], p.Data)
	sizes[0] = len(p.Data)
	eps[0] = &Endpoint{PeerPublicKey: p.PeerPublicKey}
	return 1, nil
}
