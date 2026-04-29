// Package state handles on-disk persistence of relay identity:
//   - DERP node private key (so the public key clients pin remains stable)
//   - control-plane-issued relay ID (so heartbeats keep updating the same row
//     instead of creating a new relay_servers entry on every restart)
//
// Both files live under the relay's --state-dir, default /var/lib/ourcord-relay.
package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"tailscale.com/types/key"
)

// DefaultDir is the default state directory for the relay process.
const DefaultDir = "/var/lib/ourcord-relay"

// LoadOrCreateNodeKey loads a persisted DERP node private key from path or
// generates and writes a new one (mode 0600). The DERP server's public key
// is what clients pin; rotating it on every restart would invalidate every
// client's cached pin and force re-discovery via the control plane.
func LoadOrCreateNodeKey(path string) (key.NodePrivate, error) {
	if path == "" {
		return key.NodePrivate{}, errors.New("state: empty node-key path")
	}

	if data, err := os.ReadFile(path); err == nil {
		text := strings.TrimSpace(string(data))
		var k key.NodePrivate
		if err := k.UnmarshalText([]byte(text)); err != nil {
			return key.NodePrivate{}, fmt.Errorf("state: parse %s: %w", path, err)
		}
		return k, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return key.NodePrivate{}, fmt.Errorf("state: read %s: %w", path, err)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return key.NodePrivate{}, fmt.Errorf("state: mkdir %s: %w", filepath.Dir(path), err)
	}
	k := key.NewNode()
	text, err := k.MarshalText()
	if err != nil {
		return key.NodePrivate{}, err
	}
	if err := os.WriteFile(path, append(text, '\n'), 0o600); err != nil {
		return key.NodePrivate{}, fmt.Errorf("state: write %s: %w", path, err)
	}
	return k, nil
}

// LoadRelayID reads the persisted control-plane relay ID. Returns "" with
// nil error if no ID has been persisted yet.
func LoadRelayID(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", fmt.Errorf("state: read %s: %w", path, err)
	}
	return strings.TrimSpace(string(data)), nil
}

// ClearRelayID removes the persisted relay ID file at path. Used when the
// control plane reports the relay row no longer exists (HTTP 404 on
// heartbeat) so the next heartbeat re-registers from scratch.
func ClearRelayID(path string) error {
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("state: remove %s: %w", path, err)
	}
	return nil
}

// SaveRelayID atomically writes the relay ID to path (mode 0600).
func SaveRelayID(path, id string) error {
	if path == "" || id == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("state: mkdir %s: %w", filepath.Dir(path), err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(id+"\n"), 0o600); err != nil {
		return fmt.Errorf("state: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("state: rename %s: %w", tmp, err)
	}
	return nil
}
