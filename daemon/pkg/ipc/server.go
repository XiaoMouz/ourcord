package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
)

const (
	DefaultSocketName = "ourcordd.sock"
)

// DefaultSocketPath returns the platform-appropriate default socket path.
func DefaultSocketPath() string {
	// Use /tmp on all platforms for simplicity (UI reads this)
	return filepath.Join(os.TempDir(), DefaultSocketName)
}

// Server listens on a Unix socket and dispatches IPC commands.
type Server struct {
	socketPath string
	listener   net.Listener
	handler    Handler
	hmacSecret []byte // optional; nil disables HMAC handshake
}

// Handler is called for each IPC command.
type Handler interface {
	HandleIPC(ctx context.Context, req IPCRequest) IPCResponse
}

// NewServer creates a new IPC server.
func NewServer(socketPath string, handler Handler) *Server {
	return &Server{socketPath: socketPath, handler: handler}
}

// SetHMACSecret enables W3 challenge-response HMAC auth on every accepted
// connection. Pass nil (or don't call) to keep legacy behavior.
func (s *Server) SetHMACSecret(secret []byte) {
	s.hmacSecret = secret
}

// Listen starts listening on the Unix socket.
func (s *Server) Listen() error {
	// Remove stale socket
	os.Remove(s.socketPath)
	ln, err := net.Listen("unix", s.socketPath)
	if err != nil {
		return fmt.Errorf("listen unix %s: %w", s.socketPath, err)
	}
	// K10: defense-in-depth — ensure the socket is only accessible by the
	// owning user, even on platforms where checkPeerCred is a no-op or where
	// the process umask would otherwise leave it group/world-accessible.
	if err := os.Chmod(s.socketPath, 0o600); err != nil {
		ln.Close()
		return fmt.Errorf("chmod unix %s: %w", s.socketPath, err)
	}
	s.listener = ln
	return nil
}

// Serve accepts connections and processes IPC requests.
func (s *Server) Serve(ctx context.Context) error {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return err
			}
		}
		// H11: refuse callers running as a different user. The IPC contract
		// (status / connect / disconnect / shutdown) is privileged and must
		// not be exposed to other local accounts. checkPeerCred is per-OS
		// (server_unix.go for Linux/Darwin; server_other.go is a no-op
		// fallback so the build still works on platforms without ucred).
		if err := checkPeerCred(conn); err != nil {
			conn.Close()
			continue
		}
		// W3: if a shared HMAC secret is configured, do a challenge-response
		// handshake before any IPC command is dispatched. SO_PEERCRED already
		// gates same-uid; HMAC ensures the caller also has read access to the
		// (mode-0600) ipc.key file. Failed handshake → silent close.
		if s.hmacSecret != nil {
			if err := authHandshakeServer(conn, s.hmacSecret); err != nil {
				conn.Close()
				continue
			}
		}
		go s.handleConn(ctx, conn)
	}
}

func (s *Server) handleConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	dec := json.NewDecoder(conn)
	enc := json.NewEncoder(conn)
	for {
		var req IPCRequest
		if err := dec.Decode(&req); err != nil {
			return
		}
		resp := s.handler.HandleIPC(ctx, req)
		if err := enc.Encode(resp); err != nil {
			return
		}
	}
}

// Close shuts down the server.
func (s *Server) Close() error {
	if s.listener != nil {
		return s.listener.Close()
	}
	return nil
}

// Client connects to the daemon IPC socket.
//
// Q1: a single Client wraps one net.Conn with one Encoder/Decoder pair, and
// the daemon side (`handleConn`) processes requests strictly serially per
// connection. To preserve that invariant on the caller side we serialize
// Call() and Close() with a mutex. If you need concurrent IPC throughput,
// open multiple Clients (one connection each) — do NOT share a Client across
// goroutines without this lock.
type Client struct {
	socketPath string
	conn       net.Conn
	enc        *json.Encoder
	dec        *json.Decoder
	mu         sync.Mutex
}

// NewClient creates a new IPC client. If hmacSecret is non-nil, the client
// performs the W3 HMAC handshake before returning.
func NewClient(socketPath string) (*Client, error) {
	return NewClientWithSecret(socketPath, nil)
}

// NewClientWithSecret dials and (if secret != nil) completes the HMAC
// challenge-response handshake. Returns the connected Client ready for Call().
func NewClientWithSecret(socketPath string, hmacSecret []byte) (*Client, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("dial unix %s: %w", socketPath, err)
	}
	if hmacSecret != nil {
		if err := authHandshakeClient(conn, hmacSecret); err != nil {
			conn.Close()
			return nil, fmt.Errorf("ipc auth: %w", err)
		}
	}
	return &Client{
		socketPath: socketPath,
		conn:       conn,
		enc:        json.NewEncoder(conn),
		dec:        json.NewDecoder(conn),
	}, nil
}

// Call sends an IPC command and returns the response. Safe for concurrent
// callers: the mutex enforces that one request fully completes (write +
// read) before another begins on the same connection.
func (c *Client) Call(cmd string, params map[string]string) (IPCResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	req := IPCRequest{Cmd: cmd, Params: params}
	if err := c.enc.Encode(req); err != nil {
		return IPCResponse{}, err
	}
	var resp IPCResponse
	if err := c.dec.Decode(&resp); err != nil {
		return IPCResponse{}, err
	}
	return resp, nil
}

// Close closes the connection. Safe to call concurrently with Call: the mutex
// orders the conn.Close() against any in-flight encode/decode on the same fd.
func (c *Client) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn.Close()
}
