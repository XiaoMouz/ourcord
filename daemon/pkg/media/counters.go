package media

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

const (
	// Leave legacy counters (which started at zero) behind. The top bit is
	// reserved for direction, avoiding collisions even if peer SSRCs collide.
	firstCounter uint64 = 1 << 62
	counterLimit uint64 = 1 << 63
	counterBlock uint64 = 1 << 40
)

// Counters is a reserved nonce range. Share it across peer sealers; do not
// recreate counters when a peer leaves/rejoins. Only ReserveCounters creates
// production ranges, durably advancing the high-water mark before use.
type Counters struct {
	mu        sync.Mutex
	next, end uint64
	claimed   bool
	identity  wgtypes.Key
}

func (c *Counters) claim() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.claimed {
		return errors.New("media: each engine requires a fresh nonce reservation")
	}
	c.claimed = true
	return nil
}

func (c *Counters) take() (uint64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.next >= c.end {
		return 0, errors.New("media: nonce range exhausted; rejoin voice to reserve a new range")
	}
	n := c.next
	c.next++
	return n, nil
}

// ReserveCounters reserves a range for this WireGuard identity under stateDir.
// The counter files must be retained alongside wg.key: restoring an old backup
// or cloning this identity's state requires rotating the WireGuard key.
func ReserveCounters(stateDir string, identity wgtypes.Key) (*Counters, error) {
	if stateDir == "" {
		return nil, errors.New("media: nonce state directory required")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(stateDir, "media-counter-"+hex.EncodeToString(identity[:]))
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := lockCounterFile(lock); err != nil {
		return nil, err
	}
	defer unlockCounterFile(lock)
	next := firstCounter
	data, err := os.ReadFile(path)
	if err == nil {
		next, err = decodeCounter(data, identity)
		if err != nil {
			return nil, err
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if _, err := os.Stat(path + ".initialized"); !errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("media: nonce state missing; restore current state or rotate WireGuard identity")
		}
	} else {
		return nil, err
	}
	if next > counterLimit-counterBlock {
		return nil, errors.New("media: nonce space exhausted; rotate WireGuard identity")
	}
	end := next + counterBlock
	if err := persistCounterFile(path, encodeCounter(end, identity)); err != nil {
		return nil, err
	}
	if _, err := os.Stat(path + ".initialized"); errors.Is(err, os.ErrNotExist) {
		if err := persistCounterFile(path+".initialized", []byte("retain nonce state with wg.key\n")); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	return &Counters{next: next, end: end, identity: identity}, nil
}

func encodeCounter(next uint64, identity wgtypes.Key) []byte {
	payload := fmt.Sprintf("ourcord-media-counter-v1\n%s\n%016x\n", identity.String(), next)
	sum := sha256.Sum256([]byte(payload))
	return []byte(payload + hex.EncodeToString(sum[:]) + "\n")
}

func decodeCounter(data []byte, identity wgtypes.Key) (uint64, error) {
	parts := strings.Split(string(data), "\n")
	if len(parts) != 5 || parts[0] != "ourcord-media-counter-v1" || parts[1] != identity.String() || parts[4] != "" {
		return 0, errors.New("media: invalid nonce state")
	}
	next, err := strconv.ParseUint(parts[2], 16, 64)
	if err != nil || next < firstCounter || next > counterLimit || (next-firstCounter)%counterBlock != 0 || string(encodeCounter(next, identity)) != string(data) {
		return 0, errors.New("media: corrupt nonce state")
	}
	return next, nil
}

func persistCounterFile(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".media-counter-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return replaceCounterFile(f.Name(), path)
}
