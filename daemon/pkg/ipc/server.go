package ipc

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
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
}

// Handler is called for each IPC command.
type Handler interface {
	HandleIPC(ctx context.Context, req IPCRequest) IPCResponse
}

// NewServer creates a new IPC server.
func NewServer(socketPath string, handler Handler) *Server {
	return &Server{socketPath: socketPath, handler: handler}
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
type Client struct {
	socketPath string
	conn       net.Conn
	enc        *json.Encoder
	dec        *json.Decoder
}

// NewClient creates a new IPC client.
func NewClient(socketPath string) (*Client, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("dial unix %s: %w", socketPath, err)
	}
	return &Client{
		socketPath: socketPath,
		conn:       conn,
		enc:        json.NewEncoder(conn),
		dec:        json.NewDecoder(conn),
	}, nil
}

// Call sends an IPC command and returns the response.
func (c *Client) Call(cmd string, params map[string]string) (IPCResponse, error) {
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

// Close closes the connection.
func (c *Client) Close() error { return c.conn.Close() }
