package ipc

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"
)

// HMACKeyLen is the byte length of the shared IPC HMAC secret.
const HMACKeyLen = 32

// DefaultHMACKeyPath returns ~/.config/ourcord/ipc.key (XDG aware).
func DefaultHMACKeyPath() string {
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return filepath.Join(v, "ourcord", "ipc.key")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".config", "ourcord", "ipc.key")
	}
	return filepath.Join(os.TempDir(), "ourcord-ipc.key")
}

// LoadOrCreateHMACKey reads the shared HMAC secret from path, or generates
// and persists a fresh 32-byte secret (mode 0600, dir 0700) if the file does
// not exist. Returns the raw secret bytes.
func LoadOrCreateHMACKey(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("ipc: empty hmac key path")
	}
	if data, err := os.ReadFile(path); err == nil {
		raw, derr := hex.DecodeString(string(bytesTrim(data)))
		if derr != nil {
			return nil, fmt.Errorf("ipc: decode %s: %w", path, derr)
		}
		if len(raw) != HMACKeyLen {
			return nil, fmt.Errorf("ipc: %s has %d bytes, expected %d", path, len(raw), HMACKeyLen)
		}
		return raw, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("ipc: read %s: %w", path, err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("ipc: mkdir %s: %w", filepath.Dir(path), err)
	}
	secret := make([]byte, HMACKeyLen)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("ipc: gen secret: %w", err)
	}
	encoded := hex.EncodeToString(secret) + "\n"
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		return nil, fmt.Errorf("ipc: write %s: %w", path, err)
	}
	return secret, nil
}

func bytesTrim(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r' || b[len(b)-1] == ' ' || b[len(b)-1] == '\t') {
		b = b[:len(b)-1]
	}
	for len(b) > 0 && (b[0] == ' ' || b[0] == '\t') {
		b = b[1:]
	}
	return b
}

// authChallenge is sent by the server immediately after accept. The client
// must respond with `authResponse{HMAC: hex(HMACSHA256(secret, nonce))}`.
// On valid HMAC the server proceeds with the normal IPC stream; otherwise it
// closes. SO_PEERCRED already gates same-uid; this layer adds defense-in-depth
// against a hypothetical attacker who can write to the socket as our uid (e.g.
// a confused-deputy scenario via a different ourcord helper) but does not
// have read access to ipc.key (mode 0600 in a different user-config dir).
type authChallenge struct {
	Nonce string `json:"nonce"`
}

type authResponse struct {
	HMAC string `json:"hmac"`
}

// computeHMAC returns hex(HMAC-SHA256(secret, nonce)).
func computeHMAC(secret []byte, nonce string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(nonce))
	return hex.EncodeToString(mac.Sum(nil))
}

// constantTimeEqualHex compares two equal-length hex strings in constant time.
func constantTimeEqualHex(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return hmac.Equal([]byte(a), []byte(b))
}

// authHandshakeServer issues a nonce, reads the client response, and returns
// nil iff the HMAC is valid. Bounded by a 5s deadline.
//
// Returns any bytes the underlying json.Decoder buffered past the response
// (json.Decoder uses bufio internally and can over-read into the very next
// IPC request that the client pipelines after the handshake response). The
// caller MUST use these leftover bytes (e.g. via io.MultiReader) when wiring
// the post-handshake stream — otherwise the first IPC request is silently
// dropped and the connection deadlocks (server waits for a request that has
// already been transmitted but is sitting in this discarded buffer).
func authHandshakeServer(conn net.Conn, secret []byte) ([]byte, error) {
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	defer conn.SetDeadline(time.Time{})

	nonceRaw := make([]byte, 16)
	if _, err := rand.Read(nonceRaw); err != nil {
		return nil, err
	}
	nonce := hex.EncodeToString(nonceRaw)
	enc := json.NewEncoder(conn)
	if err := enc.Encode(authChallenge{Nonce: nonce}); err != nil {
		return nil, fmt.Errorf("send challenge: %w", err)
	}
	dec := json.NewDecoder(conn)
	var resp authResponse
	if err := dec.Decode(&resp); err != nil {
		return nil, fmt.Errorf("recv response: %w", err)
	}
	expected := computeHMAC(secret, nonce)
	if !constantTimeEqualHex(resp.HMAC, expected) {
		return nil, errors.New("invalid hmac")
	}
	leftover, _ := io.ReadAll(dec.Buffered())
	// The client's json.Encoder terminates its response with '\n', which
	// dec.Decode does not consume — it belongs to the handshake framing, not
	// to the application stream. The JSON transport tolerated it (Decode skips
	// leading whitespace) but byte-exact protocols (the gRPC HTTP/2 preface)
	// must start clean, so strip leading JSON whitespace here.
	for len(leftover) > 0 && (leftover[0] == '\n' || leftover[0] == '\r' || leftover[0] == ' ' || leftover[0] == '\t') {
		leftover = leftover[1:]
	}
	return leftover, nil
}

// authHandshakeClient reads the nonce, computes the HMAC, and sends the
// response. Bounded by a 5s deadline.
func authHandshakeClient(conn net.Conn, secret []byte) error {
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	defer conn.SetDeadline(time.Time{})

	dec := json.NewDecoder(conn)
	var ch authChallenge
	if err := dec.Decode(&ch); err != nil {
		if errors.Is(err, io.EOF) {
			return errors.New("server closed before challenge")
		}
		return fmt.Errorf("recv challenge: %w", err)
	}
	enc := json.NewEncoder(conn)
	if err := enc.Encode(authResponse{HMAC: computeHMAC(secret, ch.Nonce)}); err != nil {
		return fmt.Errorf("send response: %w", err)
	}
	return nil
}
