//go:build windows

package ipc

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"

	winio "github.com/tailscale/go-winio"
)

const DefaultSocketName = `\\.\pipe\ourcordd`

func DefaultSocketPath() string { return DefaultSocketName }

// The pipe is local-only by construction. Its DACL grants full access to
// SYSTEM/Administrators and read/write to authenticated local users. The
// current daemon profile is machine-wide, so this transport intentionally
// supports one enrolled OurCord account per machine; per-SID profiles require
// propagating the impersonated pipe caller through gRPC and are not implied by
// this DACL.
const pipeSDDL = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)"

func ListenAuthenticated(pipePath string, secret []byte) (net.Listener, error) {
	ln, err := winio.ListenPipe(pipePath, &winio.PipeConfig{
		SecurityDescriptor: pipeSDDL,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
	if err != nil {
		return nil, fmt.Errorf("listen named pipe %s: %w", pipePath, err)
	}
	return &authListener{Listener: ln, secret: secret}, nil
}

type authListener struct {
	net.Listener
	secret []byte
}

func (l *authListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if l.secret == nil {
			return conn, nil
		}
		leftover, err := authHandshakeServer(conn, l.secret)
		if err != nil {
			_ = conn.Close()
			continue
		}
		if len(leftover) == 0 {
			return conn, nil
		}
		return &prebufConn{Conn: conn, r: io.MultiReader(bytes.NewReader(leftover), conn)}, nil
	}
}

type prebufConn struct {
	net.Conn
	r io.Reader
}

func (c *prebufConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func DialAuthenticated(ctx context.Context, pipePath string, secret []byte) (net.Conn, error) {
	conn, err := winio.DialPipeContext(ctx, pipePath)
	if err != nil {
		return nil, err
	}
	if secret != nil {
		if err := authHandshakeClient(conn, secret); err != nil {
			_ = conn.Close()
			return nil, fmt.Errorf("ipc auth: %w", err)
		}
	}
	return conn, nil
}
