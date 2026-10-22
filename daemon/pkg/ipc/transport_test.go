package ipc

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func tempSocket(t *testing.T) (string, []byte) {
	t.Helper()
	// Short prefix, not t.TempDir(): a long test name would overflow the ~104
	// char unix-socket path limit on macOS/BSD.
	dir, err := os.MkdirTemp("", "oc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	secret, err := LoadOrCreateHMACKey(filepath.Join(dir, "ipc.key"))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		return `\\.\pipe\ourcord-test-` + filepath.Base(dir), secret
	}
	return filepath.Join(dir, "s"), secret
}

func TestListenAuthenticatedDoesNotReplaceLiveSocket(t *testing.T) {
	sock, _ := tempSocket(t)
	first, err := ListenAuthenticated(sock, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })

	if second, err := ListenAuthenticated(sock, nil); err == nil {
		second.Close()
		t.Fatalf("second listener error = %v, want already running", err)
	}

	accepted := make(chan error, 1)
	go func() {
		connection, err := first.Accept()
		if err == nil {
			_ = connection.Close()
		}
		accepted <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := DialAuthenticated(ctx, sock, nil)
	if err != nil {
		t.Fatalf("original listener was replaced: %v", err)
	}
	defer conn.Close()
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatalf("original listener stopped accepting: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("original listener did not accept the connection")
	}
}

func TestListenAuthenticatedForCurrentUID(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix UID ownership and mode bits do not apply to Windows named pipes")
	}
	sock, secret := tempSocket(t)
	lis, err := ListenAuthenticatedForUID(sock, secret, os.Getuid())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lis.Close() })

	info, err := os.Stat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o, want 600", info.Mode().Perm())
	}

	accepted := make(chan error, 1)
	go func() {
		conn, err := lis.Accept()
		if err == nil {
			_ = conn.Close()
		}
		accepted <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := DialAuthenticated(ctx, sock, secret)
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if err := <-accepted; err != nil {
		t.Fatal(err)
	}
}

// TestAuthenticatedTransportPreservesPipelinedBytes proves the prebuf replay:
// bytes the client pipelines immediately after its handshake response (as gRPC
// does with the HTTP/2 preface) must reach the server-side reader intact.
func TestAuthenticatedTransportPreservesPipelinedBytes(t *testing.T) {
	sock, secret := tempSocket(t)
	lis, err := ListenAuthenticated(sock, secret)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lis.Close() })

	got := make(chan []byte, 1)
	go func() {
		conn, err := lis.Accept()
		if err != nil {
			got <- nil
			return
		}
		defer conn.Close()
		buf := make([]byte, 16)
		if _, err := io.ReadFull(conn, buf); err != nil {
			got <- nil
			return
		}
		got <- buf
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := DialAuthenticated(ctx, sock, secret)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	payload := []byte("PRI * HTTP/2.0\r\n") // 16 bytes, preface-shaped
	if _, err := conn.Write(payload); err != nil {
		t.Fatal(err)
	}

	select {
	case buf := <-got:
		if string(buf) != string(payload) {
			t.Fatalf("server read %q, want %q", buf, payload)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server never received the pipelined bytes")
	}
}

// TestAuthenticatedListenerRejectsWrongKey: an invalid HMAC never yields a conn
// to the server application; the listener keeps accepting afterwards.
func TestAuthenticatedListenerRejectsWrongKey(t *testing.T) {
	sock, secret := tempSocket(t)
	lis, err := ListenAuthenticated(sock, secret)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lis.Close() })

	accepted := make(chan struct{}, 1)
	go func() {
		if conn, err := lis.Accept(); err == nil {
			conn.Close()
			accepted <- struct{}{}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	wrong := make([]byte, HMACKeyLen)
	if conn, err := DialAuthenticated(ctx, sock, wrong); err == nil {
		// Client-side handshake may report success (server closes silently);
		// the connection must still be dead.
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Read(make([]byte, 1)); err == nil {
			t.Fatal("conn with wrong key should be closed by the server")
		}
		conn.Close()
	}
	select {
	case <-accepted:
		t.Fatal("listener must not surface a wrong-key conn")
	case <-time.After(300 * time.Millisecond):
	}

	// A correct-key client still gets through after the rejected one.
	go func() {
		if conn, err := lis.Accept(); err == nil {
			conn.Close()
			accepted <- struct{}{}
		}
	}()
	conn, err := DialAuthenticated(ctx, sock, secret)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	select {
	case <-accepted:
	case <-time.After(3 * time.Second):
		t.Fatal("listener stopped accepting after a rejected conn")
	}
}
