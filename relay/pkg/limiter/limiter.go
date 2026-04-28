// Package limiter implements per-connection bandwidth limiting using token buckets.
package limiter

import (
	"io"
	"sync"

	"golang.org/x/time/rate"
)

// Manager tracks per-key bandwidth limiters.
type Manager struct {
	mu       sync.Mutex
	limiters map[string]*rate.Limiter
	limitBps int // bytes per second limit; 0 = unlimited
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

// LimitedWriter wraps an io.Writer with rate limiting.
type LimitedWriter struct {
	w       io.Writer
	limiter *rate.Limiter
}

// NewLimitedWriter creates a rate-limited writer. If limiter is nil, no limiting is applied.
func NewLimitedWriter(w io.Writer, limiter *rate.Limiter) io.Writer {
	if limiter == nil {
		return w
	}
	return &LimitedWriter{w: w, limiter: limiter}
}

func (lw *LimitedWriter) Write(p []byte) (int, error) {
	// Wait for permission to write len(p) bytes
	// For large writes, split into chunks to respect the rate limit accurately
	const chunkSize = 4096
	written := 0
	for written < len(p) {
		end := written + chunkSize
		if end > len(p) {
			end = len(p)
		}
		chunk := p[written:end]
		if err := lw.limiter.WaitN(nil, len(chunk)); err != nil {
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
