// Package limiter implements per-connection bandwidth limiting using token buckets.
package limiter

import (
	"context"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"
)

// Manager tracks per-key bandwidth limiters.
type Manager struct {
	mu         sync.Mutex
	limiters   map[string]*rate.Limiter
	limitBps   int          // bytes per second limit; 0 = unlimited
	bytesTotal atomic.Int64 // running total of bytes written across all wrapped conns
}

// NewManager creates a rate limiter manager.
// limitBps=0 disables rate limiting.
func NewManager(limitBps int) *Manager {
	return &Manager{
		limiters: make(map[string]*rate.Limiter),
		limitBps: limitBps,
	}
}

// GetLimiter returns (or creates) the limiter for a given key.
// Returns nil when rate limiting is disabled (limitBps == 0).
func (m *Manager) GetLimiter(key string) *rate.Limiter {
	if m.limitBps == 0 {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.limiters[key]
	if !ok {
		// Burst = 1 second worth of data
		l = rate.NewLimiter(rate.Limit(m.limitBps), m.limitBps)
		m.limiters[key] = l
	}
	return l
}

// Remove removes the limiter for a key (called on disconnect).
func (m *Manager) Remove(key string) {
	m.mu.Lock()
	delete(m.limiters, key)
	m.mu.Unlock()
}

// Enabled reports whether rate limiting is active.
func (m *Manager) Enabled() bool { return m.limitBps > 0 }

// BytesTotal returns the cumulative bytes written through all wrapped
// connections since the manager was created. Use this with periodic sampling
// to derive a bytes-per-second figure for capacity reporting. Counted even
// when rate limiting itself is disabled, so the relay can report load
// without enforcing a floor.
func (m *Manager) BytesTotal() int64 { return m.bytesTotal.Load() }

func (m *Manager) addBytes(n int) {
	if n > 0 {
		m.bytesTotal.Add(int64(n))
	}
}

// LimitedWriter wraps an io.Writer with rate limiting.
type LimitedWriter struct {
	w       io.Writer
	limiter *rate.Limiter
	ctx     context.Context
}

// NewLimitedWriter creates a rate-limited writer. If limiter is nil, no limiting is applied.
// ctx controls cancellation while waiting for tokens; pass context.Background() if no cancellation needed.
func NewLimitedWriter(ctx context.Context, w io.Writer, limiter *rate.Limiter) io.Writer {
	if limiter == nil {
		return w
	}
	return &LimitedWriter{w: w, limiter: limiter, ctx: ctx}
}

func (lw *LimitedWriter) Write(p []byte) (int, error) {
	// For large writes, split into chunks to respect the rate limit accurately.
	// chunkSize must not exceed the limiter's burst.
	const chunkSize = 4096
	written := 0
	for written < len(p) {
		end := written + chunkSize
		if end > len(p) {
			end = len(p)
		}
		chunk := p[written:end]
		if err := lw.limiter.WaitN(lw.ctx, len(chunk)); err != nil {
			return written, err
		}
		n, err := lw.w.Write(chunk)
		written += n
		if err != nil {
			return written, err
		}
	}
	return written, nil
}

// limitedConn wraps a net.Conn so that Write goes through a rate limiter.
// On Close it removes the limiter from the manager.
type limitedConn struct {
	net.Conn
	w       io.Writer // the rate-limited writer
	mgr     *Manager
	key     string
	ctx     context.Context
	cancel  context.CancelFunc
	closeMu sync.Once
}

func (c *limitedConn) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.mgr.addBytes(n)
	return n, err
}
func (c *limitedConn) Close() error {
	c.closeMu.Do(func() {
		c.cancel()
		c.mgr.Remove(c.key)
	})
	return c.Conn.Close()
}
func (c *limitedConn) SetDeadline(t time.Time) error      { return c.Conn.SetDeadline(t) }
func (c *limitedConn) SetReadDeadline(t time.Time) error  { return c.Conn.SetReadDeadline(t) }
func (c *limitedConn) SetWriteDeadline(t time.Time) error { return c.Conn.SetWriteDeadline(t) }

// WrapConn returns a net.Conn whose Write path is rate-limited per the manager's setting
// and whose write byte count is added to the manager's running total.
// If m is nil the conn is returned unchanged. When the manager is disabled,
// no rate limit is applied but writes are still counted (so the relay can
// report load even when not enforcing a floor).
// The limiter is keyed by the remote address; on Close it is removed from the manager.
func WrapConn(parent context.Context, c net.Conn, m *Manager) net.Conn {
	if m == nil {
		return c
	}
	key := c.RemoteAddr().String()
	var l *rate.Limiter
	if m.Enabled() {
		l = m.GetLimiter(key)
	}
	ctx, cancel := context.WithCancel(parent)
	return &limitedConn{
		Conn:   c,
		w:      NewLimitedWriter(ctx, c, l),
		mgr:    m,
		key:    key,
		ctx:    ctx,
		cancel: cancel,
	}
}

// limitedListener wraps a net.Listener so each accepted Conn is rate-limited.
type limitedListener struct {
	net.Listener
	mgr *Manager
	ctx context.Context
}

func (l *limitedListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return WrapConn(l.ctx, c, l.mgr), nil
}

// WrapListener wraps a listener so accepted connections share the manager's rate limit
// (one bucket per remote address) and contribute to the manager's byte counter.
// If m is nil the listener is returned unchanged.
//
// Use this *before* tls.NewListener so the limit is applied at the byte level (ciphertext).
// For DERP this is acceptable: the 128 Kbps floor is a wire-rate guarantee, not an app-rate one.
func WrapListener(ctx context.Context, ln net.Listener, m *Manager) net.Listener {
	if m == nil {
		return ln
	}
	return &limitedListener{Listener: ln, mgr: m, ctx: ctx}
}
