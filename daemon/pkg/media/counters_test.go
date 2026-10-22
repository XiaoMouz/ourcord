package media

import (
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func counterPath(dir string, key wgtypes.Key) string {
	return filepath.Join(dir, "media-counter-"+hex.EncodeToString(key[:]))
}

func TestCounterReservationsSurviveReopen(t *testing.T) {
	dir, identity := t.TempDir(), mustKey(t).PublicKey()
	first, err := ReserveCounters(dir, identity)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ReserveCounters(dir, identity)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := first.take()
	b, _ := second.take()
	if a != firstCounter || b != firstCounter+counterBlock {
		t.Fatalf("overlapping reservations: %d %d", a, b)
	}
	a2, _ := first.take()
	if a2 != a+1 {
		t.Fatal("another reservation changed the original range")
	}
}

func TestConcurrentCounterReservations(t *testing.T) {
	dir, identity := t.TempDir(), mustKey(t).PublicKey()
	const count = 16
	values := make([]uint64, count)
	var wg sync.WaitGroup
	for i := range values {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c, err := ReserveCounters(dir, identity)
			if err != nil {
				t.Error(err)
				return
			}
			values[i], err = c.take()
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	for i, value := range values {
		if value != firstCounter+uint64(i)*counterBlock {
			t.Fatalf("reservation %d: %d", i, value)
		}
	}
}

func TestCounterProcessHelper(t *testing.T) {
	dir := os.Getenv("OURCORD_TEST_COUNTER_DIR")
	if dir == "" {
		t.Skip("subprocess helper")
	}
	identity, err := wgtypes.ParseKey(os.Getenv("OURCORD_TEST_COUNTER_ID"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := ReserveCounters(dir, identity)
	if err != nil {
		t.Fatal(err)
	}
	n, err := c.take()
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("%d\n", n)
	os.Exit(0)
}

func TestCounterReservationsAcrossProcesses(t *testing.T) {
	dir, identity := t.TempDir(), mustKey(t).PublicKey()
	values := make([]uint64, 3)
	var wg sync.WaitGroup
	for i := range values {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			cmd := exec.Command(os.Args[0], "-test.run=^TestCounterProcessHelper$")
			cmd.Env = append(os.Environ(), "OURCORD_TEST_COUNTER_DIR="+dir, "OURCORD_TEST_COUNTER_ID="+identity.String())
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Errorf("helper: %v: %s", err, out)
				return
			}
			values[i], err = strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	for i, n := range values {
		if n != firstCounter+uint64(i)*counterBlock {
			t.Fatalf("process reservations: %v", values)
		}
	}
}

func TestCounterStateFailsClosed(t *testing.T) {
	for _, damage := range []string{"missing", "truncated", "checksum", "wrong-identity", "exhausted"} {
		t.Run(damage, func(t *testing.T) {
			dir, identity := t.TempDir(), mustKey(t).PublicKey()
			if _, err := ReserveCounters(dir, identity); err != nil {
				t.Fatal(err)
			}
			path := counterPath(dir, identity)
			var err error
			switch damage {
			case "missing":
				err = os.Remove(path)
			case "truncated":
				err = os.WriteFile(path, []byte("ourcord-media-counter"), 0o600)
			case "checksum":
				data := encodeCounter(firstCounter, identity)
				data[len(data)-3] ^= 1
				err = os.WriteFile(path, data, 0o600)
			case "wrong-identity":
				err = os.WriteFile(path, encodeCounter(firstCounter, mustKey(t).PublicKey()), 0o600)
			case "exhausted":
				err = os.WriteFile(path, encodeCounter(counterLimit, identity), 0o600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ReserveCounters(dir, identity); err == nil {
				t.Fatal("damaged nonce state silently reset")
			}
		})
	}
}

func TestCounterExhaustionNeverWraps(t *testing.T) {
	c := &Counters{next: counterLimit - 1, end: counterLimit}
	if got, err := c.take(); err != nil || got != counterLimit-1 {
		t.Fatalf("last counter: %d %v", got, err)
	}
	for i := 0; i < 2; i++ {
		if _, err := c.take(); err == nil {
			t.Fatal("counter wrapped")
		}
	}
	if err := c.claim(); err != nil {
		t.Fatal(err)
	}
	if err := c.claim(); err == nil {
		t.Fatal("reservation reused by another engine")
	}
}

func TestCounterStorageFailureDoesNotAllocate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"", path} {
		if c, err := ReserveCounters(dir, mustKey(t).PublicKey()); err == nil || c != nil {
			t.Fatal("allocated without durable storage")
		}
	}
	if e, err := Start(Config{}); err == nil || e != nil {
		t.Fatal("started without nonce reservation")
	}
}
