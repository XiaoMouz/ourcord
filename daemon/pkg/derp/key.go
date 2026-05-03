package derp

import (
	"fmt"
	"os"
	"path/filepath"

	"tailscale.com/types/key"
)

// LoadOrCreateNodeKey loads a stable DERP node private key from path, or
// creates one. This key is the daemon's identity on DERP and is separate from
// its WireGuard key.
func LoadOrCreateNodeKey(path string) (key.NodePrivate, error) {
	if data, err := os.ReadFile(path); err == nil {
		var priv key.NodePrivate
		if err := priv.UnmarshalText(data); err != nil {
			return key.NodePrivate{}, fmt.Errorf("parse derp node key: %w", err)
		}
		return priv, nil
	} else if !os.IsNotExist(err) {
		return key.NodePrivate{}, fmt.Errorf("read derp node key: %w", err)
	}

	priv := key.NewNode()
	data, err := priv.MarshalText()
	if err != nil {
		return key.NodePrivate{}, fmt.Errorf("marshal derp node key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return key.NodePrivate{}, fmt.Errorf("mkdir derp key dir: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return key.NodePrivate{}, fmt.Errorf("write derp node key: %w", err)
	}
	return priv, nil
}
