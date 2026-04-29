package wg

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// LoadOrCreateKeyPair reads a WireGuard private key from path. If the file
// does not exist, it generates a new key pair and writes it (mode 0600,
// directory mode 0700) before returning. Persistence is critical because
// without it the daemon would receive a fresh VPN identity on every restart,
// quickly exhausting the control plane's IP pool and breaking peer trust.
//
// File format: a single line with the private key as base64 (wgtypes.Key
// String() representation), optional trailing newline. Comments / blank lines
// not supported on purpose to keep the format trivial.
func LoadOrCreateKeyPair(path string) (*KeyPair, error) {
	if path == "" {
		return nil, errors.New("wg: empty key path")
	}

	if data, err := os.ReadFile(path); err == nil {
		text := strings.TrimSpace(string(data))
		raw, derr := base64.StdEncoding.DecodeString(text)
		if derr != nil {
			return nil, fmt.Errorf("wg: decode %s: %w", path, derr)
		}
		if len(raw) != wgtypes.KeyLen {
			return nil, fmt.Errorf("wg: %s has %d bytes, expected %d", path, len(raw), wgtypes.KeyLen)
		}
		var priv wgtypes.Key
		copy(priv[:], raw)
		return &KeyPair{Private: priv, Public: priv.PublicKey()}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("wg: read %s: %w", path, err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("wg: mkdir %s: %w", filepath.Dir(path), err)
	}
	kp, err := GenerateKeyPair()
	if err != nil {
		return nil, err
	}
	encoded := base64.StdEncoding.EncodeToString(kp.Private[:]) + "\n"
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		return nil, fmt.Errorf("wg: write %s: %w", path, err)
	}
	return kp, nil
}

// DefaultStateDir returns a per-user writable directory for daemon state.
// Honors XDG_STATE_HOME first, then $HOME/.local/share/ourcord, then the
// process working directory as a last resort.
func DefaultStateDir() string {
	if v := os.Getenv("XDG_STATE_HOME"); v != "" {
		return filepath.Join(v, "ourcord")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".local", "share", "ourcord")
	}
	return "."
}
