package limiter

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestLimitedWriter_Throughput(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping throughput test in short mode")
	}
	m := NewManager(16 * 1024) // 16 KiB/s
	l := m.GetLimiter("k")
	pr, pw := io.Pipe()
	defer pr.Close()
	w := NewLimitedWriter(context.Background(), pw, l)

	go func() {
		// Drain the pipe so writes don't block on the reader.
		buf := make([]byte, 4096)
		for {
			if _, err := pr.Read(buf); err != nil {
				return
			}
		}
	}()

	start := time.Now()
	const total = 32 * 1024 // 2 seconds worth at 16 KiB/s
	if _, err := w.Write(make([]byte, total)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	elapsed := time.Since(start)
	// Allow some slack; we should take ~1s (burst eats the first second).
	if elapsed < 800*time.Millisecond {
		t.Errorf("write completed too fast (%s); rate limiter not working", elapsed)
	}
}

func TestLimitedWriter_NoLimit(t *testing.T) {
	w := NewLimitedWriter(context.Background(), io.Discard, nil)
	n, err := w.Write([]byte("hello"))
	if err != nil || n != 5 {
		t.Fatalf("Write: n=%d err=%v", n, err)
	}
}

func TestManagerRemove(t *testing.T) {
	m := NewManager(1024)
	_ = m.GetLimiter("foo")
	if _, ok := m.limiters["foo"]; !ok {
		t.Fatalf("limiter not registered")
	}
	m.Remove("foo")
	if _, ok := m.limiters["foo"]; ok {
		t.Errorf("limiter still present after Remove")
	}
}

func TestManagerEnabled(t *testing.T) {
	if NewManager(0).Enabled() {
		t.Errorf("0 should be disabled")
	}
	if !NewManager(1).Enabled() {
		t.Errorf("1 should be enabled")
	}
}

func TestManagerBytesTotal_CountedEvenWhenDisabled(t *testing.T) {
	m := NewManager(0) // limiter disabled but counting must still work (F6 fix)
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	wrapped := WrapConn(context.Background(), a, m)
	go io.Copy(io.Discard, b)
	if _, err := wrapped.Write([]byte("hello world")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	// Allow goroutine to drain
	time.Sleep(20 * time.Millisecond)
	if got := m.BytesTotal(); got != 11 {
		t.Errorf("BytesTotal = %d, want 11", got)
	}
}

func TestWrapConn_NilManager(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	c := WrapConn(context.Background(), a, nil)
	if c != a {
		t.Errorf("nil manager should return conn unchanged")
	}
}

func TestLimitedConn_CloseRemovesFromManager(t *testing.T) {
	m := NewManager(1024)
	a, b := net.Pipe()
	defer b.Close()
	wrapped := WrapConn(context.Background(), a, m)
	key := a.RemoteAddr().String()
	if _, ok := m.limiters[key]; !ok {
		t.Fatalf("limiter not registered")
	}
	wrapped.Close()
	if _, ok := m.limiters[key]; ok {
		t.Errorf("limiter not removed after Close")
	}
}
