package media

import (
	"net/netip"
	"sync"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// fabric is an in-memory UDP substitute: engines register their VPN addr and
// datagrams are delivered to the addressee's inbox. It lets the full pipeline
// (encode → seal → RTP → "network" → parse → open → decode → jitter) run with
// no real sockets, deterministically.
type fabric struct {
	mu    sync.Mutex
	inbox map[netip.Addr]chan datagram
}

type datagram struct {
	from netip.AddrPort
	data []byte
}

func newFabric() *fabric { return &fabric{inbox: make(map[netip.Addr]chan datagram)} }

func (f *fabric) endpoint(addr netip.Addr) *fabricConn {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := make(chan datagram, 256)
	f.inbox[addr] = ch
	return &fabricConn{fab: f, self: addr, in: ch, closed: make(chan struct{})}
}

type fabricConn struct {
	fab    *fabric
	self   netip.Addr
	in     chan datagram
	closed chan struct{}
}

func (c *fabricConn) WriteToUDPAddrPort(b []byte, dst netip.AddrPort) (int, error) {
	c.fab.mu.Lock()
	ch := c.fab.inbox[dst.Addr()]
	c.fab.mu.Unlock()
	if ch != nil {
		cp := append([]byte(nil), b...)
		select {
		case ch <- datagram{from: netip.AddrPortFrom(c.self, VoicePort), data: cp}:
		default: // drop if inbox full — mirrors UDP
		}
	}
	return len(b), nil
}

func (c *fabricConn) ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error) {
	select {
	case <-c.closed:
		return 0, netip.AddrPort{}, errClosed
	case d := <-c.in:
		n := copy(b, d.data)
		return n, d.from, nil
	}
}

func (c *fabricConn) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	return nil
}

var errClosed = &closedErr{}

type closedErr struct{}

func (*closedErr) Error() string { return "closed" }

// tone drives a capture source with a recognizable non-silent frame so the
// receiver can assert real audio arrived (not just packets).
func tone(stop <-chan struct{}) <-chan []int16 {
	ch := make(chan []int16)
	go func() {
		t := time.NewTicker(2 * time.Millisecond) // faster than real-time for tests
		defer t.Stop()
		var phase int16 = 1000
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				f := make([]int16, FrameSamples)
				for i := range f {
					f[i] = phase
				}
				phase = -phase
				select {
				case ch <- f:
				case <-stop:
					return
				}
			}
		}
	}()
	return ch
}

func TestTwoEnginesEndToEndVoice(t *testing.T) {
	fab := newFabric()
	keyA, keyB := mustKey(t), mustKey(t)
	addrA := netip.MustParseAddr("198.18.0.2")
	addrB := netip.MustParseAddr("198.18.0.3")

	stop := make(chan struct{})
	defer close(stop)

	a, err := Start(Config{SelfKey: keyA, VPN4: addrA, NetworkID: "lobby-x-voice", Conn: fab.endpoint(addrA), CaptureSource: tone(stop)})
	if err != nil {
		t.Fatal(err)
	}
	defer a.Stop()
	b, err := Start(Config{SelfKey: keyB, VPN4: addrB, NetworkID: "lobby-x-voice", Conn: fab.endpoint(addrB)})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Stop()

	a.UpdatePeers([]PeerInfo{{PublicKey: keyB.PublicKey(), VPN4: addrB}})
	b.UpdatePeers([]PeerInfo{{PublicKey: keyA.PublicKey(), VPN4: addrA}})

	// B should see A speaking with real decoded audio and ~no loss.
	if !waitFor(t, time.Second, func() bool {
		for _, p := range b.Status().Participants {
			if p.PublicKey == keyA.PublicKey() && p.Speaking && p.Secure && p.PacketsRx > 5 {
				return true
			}
		}
		return false
	}) {
		t.Fatalf("B never heard A speaking: %+v", b.Status())
	}

	// Mute A → B stops hearing new packets.
	a.SetMute(true)
	rxAtMute := participantRx(b.Status(), keyA.PublicKey())
	time.Sleep(150 * time.Millisecond)
	if grew := participantRx(b.Status(), keyA.PublicKey()) - rxAtMute; grew > 2 {
		t.Fatalf("muted sender still delivered %d packets", grew)
	}
}

func TestWrongKeyPeerCannotDecrypt(t *testing.T) {
	fab := newFabric()
	keyA, keyB, keyEve := mustKey(t), mustKey(t), mustKey(t)
	addrA := netip.MustParseAddr("198.18.0.2")
	addrEve := netip.MustParseAddr("198.18.0.9")

	stop := make(chan struct{})
	defer close(stop)

	a, _ := Start(Config{SelfKey: keyA, VPN4: addrA, Conn: fab.endpoint(addrA), CaptureSource: tone(stop)})
	defer a.Stop()
	// Eve joins with her own key but claims to expect A. A is NOT told about Eve,
	// so A never sends to her; even if she received A's packets (addressed to B),
	// her opener derives pairKey(Eve,A) ≠ pairKey(A,B) and cannot decrypt.
	eve, _ := Start(Config{SelfKey: keyEve, VPN4: addrEve, Conn: fab.endpoint(addrEve)})
	defer eve.Stop()

	a.UpdatePeers([]PeerInfo{{PublicKey: keyB.PublicKey(), VPN4: netip.MustParseAddr("198.18.0.3")}})
	eve.UpdatePeers([]PeerInfo{{PublicKey: keyA.PublicKey(), VPN4: addrA}})

	time.Sleep(200 * time.Millisecond)
	if rx := participantRx(eve.Status(), keyA.PublicKey()); rx != 0 {
		t.Fatalf("eavesdropper decrypted %d packets", rx)
	}
}

func participantRx(s Status, key wgtypes.Key) uint64 {
	for _, p := range s.Participants {
		if p.PublicKey == key {
			return p.PacketsRx
		}
	}
	return 0
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}
