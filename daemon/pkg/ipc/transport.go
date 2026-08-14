//go:build !windows

package ipc

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"
)

const (
	// DefaultSocketName is the daemon's IPC socket filename.
	DefaultSocketName = "ourcordd.sock"
)

// DefaultSocketPath returns the platform-appropriate default socket path.
func DefaultSocketPath() string {
	// Use /tmp on all platforms for simplicity (UI reads this)
	return filepath.Join(os.TempDir(), DefaultSocketName)
}

// Authenticated unix-socket transport primitives for the gRPC IPC layer.
// Every accepted connection is gated by the same two checks the original JSON
// transport used, in order: SO_PEERCRED (same uid) and the W3 HMAC
// challenge-response (possession of the mode-0600 ipc.key). Only after both
// pass is the connection handed to gRPC — HTTP/2 never starts on an
// unauthenticated conn, and the handshake helpers clear their deadlines so
// long-lived streams are unaffected.

// ListenAuthenticated listens on socketPath (mode 0600, stale socket replaced)
// and authenticates every connection in Accept. A nil secret skips the HMAC
// handshake (tests); peercred is always enforced.
func ListenAuthenticated(socketPath string, secret []byte) (net.Listener, error) {
	return listenAuthenticated(socketPath, secret, os.Getuid(), -1)
}

// ListenAuthenticatedForUID creates an authenticated listener controlled by a
// single non-daemon UID. It is used by the macOS launchd service: ourcordd runs
// as root to manage utun/routes, while only the user who installed the helper
// may reach its socket. The HMAC handshake remains mandatory when secret is
// non-nil, so peer credentials are not the only authorization boundary.
func ListenAuthenticatedForUID(socketPath string, secret []byte, allowedUID int) (net.Listener, error) {
	if allowedUID < 0 {
		return nil, fmt.Errorf("ipc: invalid allowed uid %d", allowedUID)
	}
	return listenAuthenticated(socketPath, secret, allowedUID, allowedUID)
}

func listenAuthenticated(socketPath string, secret []byte, allowedUID, socketOwnerUID int) (net.Listener, error) {
	// Do not unlink a live daemon's socket. This matters for desktop-managed
	// sidecars after an app crash: a replacement process must reuse the live
	// daemon instead of orphaning it behind a newly bound socket path.
	if conn, err := net.DialTimeout("unix", socketPath, 200*time.Millisecond); err == nil {
		conn.Close()
		return nil, fmt.Errorf("listen unix %s: daemon already running", socketPath)
	}
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("remove stale unix socket %s: %w", socketPath, err)
	}
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen unix %s: %w", socketPath, err)
	}
	// K10: defense-in-depth — owner-only even where peercred is a no-op or the
	// umask would leave the socket group/world-accessible.
	if err := os.Chmod(socketPath, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod unix %s: %w", socketPath, err)
	}
	if socketOwnerUID >= 0 {
		if err := os.Chown(socketPath, socketOwnerUID, -1); err != nil {
			ln.Close()
			return nil, fmt.Errorf("chown unix %s to uid %d: %w", socketPath, socketOwnerUID, err)
		}
	}
	return &authListener{Listener: ln, secret: secret, allowedUID: allowedUID}, nil
}

type authListener struct {
	net.Listener
	secret     []byte
	allowedUID int
}

// Accept authenticates serially (the handshake is deadline-bounded and local,
// so a failing client stalls accepts for at most a few seconds — same tradeoff
// as the previous JSON server). Auth failures close the conn and continue;
// they are never surfaced as Accept errors, which grpc.Server would treat as
// fatal.
func (l *authListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if err := checkPeerCred(conn, l.allowedUID); err != nil {
			conn.Close()
			continue
		}
		if l.secret == nil {
			return conn, nil
		}
		leftover, err := authHandshakeServer(conn, l.secret)
		if err != nil {
			conn.Close()
			continue
		}
		if len(leftover) == 0 {
			return conn, nil
		}
		// The handshake decoder over-read into bytes the client pipelined after
		// its response (e.g. the HTTP/2 preface). Replay them ahead of the conn.
		return &prebufConn{Conn: conn, r: io.MultiReader(bytes.NewReader(leftover), conn)}, nil
	}
}

type prebufConn struct {
	net.Conn
	r io.Reader
}

func (c *prebufConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// DialAuthenticated dials the daemon socket and completes the client half of
// the HMAC handshake before returning the conn (ready for gRPC to take over).
// A nil secret skips the handshake.
func DialAuthenticated(ctx context.Context, socketPath string, secret []byte) (net.Conn, error) {
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", socketPath)
	if err != nil {
		return nil, err
	}
	if secret != nil {
		if err := authHandshakeClient(conn, secret); err != nil {
			conn.Close()
			return nil, fmt.Errorf("ipc auth: %w", err)
		}
	}
	return conn, nil
}
