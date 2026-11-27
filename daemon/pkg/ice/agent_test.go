package ice

import (
	"net"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pionice "github.com/pion/ice/v4"
	"github.com/pion/stun/v3"
)

func localSTUNIP(t *testing.T) net.IP {
	t.Helper()
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	var localIP net.IP
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp == 0 || networkInterface.Flags&net.FlagLoopback != 0 || !buildInterfaceFilter(nil)(networkInterface.Name) {
			continue
		}
		addresses, err := networkInterface.Addrs()
		if err != nil {
			t.Fatal(err)
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil && ip.IsGlobalUnicast() {
				localIP = ip.To4()
				break
			}
		}
		if localIP != nil {
			break
		}
	}
	if localIP == nil {
		t.Skip("no usable non-loopback IPv4 interface for local STUN")
	}
	return localIP
}

func fakeSTUN(t *testing.T) (*net.UDPAddr, func()) {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: localSTUNIP(t), Port: 0})
	if err != nil {
		t.Fatalf("listen fake stun: %v", err)
	}
	done := make(chan struct{})
	stopped := make(chan struct{})
	var requests atomic.Int64
	go func() {
		defer close(stopped)
		buf := make([]byte, 1500)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(250 * time.Millisecond))
			n, src, err := conn.ReadFromUDP(buf)
			select {
			case <-done:
				return
			default:
			}
			if err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					continue
				}
				return
			}
			req := &stun.Message{Raw: append([]byte{}, buf[:n]...)}
			if err := req.Decode(); err != nil {
				continue
			}
			if req.Type != stun.BindingRequest {
				continue
			}
			requests.Add(1)
			resp, err := stun.Build(
				stun.NewTransactionIDSetter(req.TransactionID),
				stun.BindingSuccess,
				&stun.XORMappedAddress{IP: src.IP, Port: src.Port},
				stun.Fingerprint,
			)
			if err != nil {
				continue
			}
			_, _ = conn.WriteToUDP(resp.Raw, src)
		}
	}()
	cleanup := func() {
		close(done)
		_ = conn.Close()
		<-stopped
		if requests.Load() == 0 {
			t.Error("fake STUN server did not receive any binding requests")
		}
	}
	return conn.LocalAddr().(*net.UDPAddr), cleanup
}

// gatherWith creates an Agent with the given STUN servers, runs gathering, and
// returns the gathered candidate strings (parsed back into Candidate).
func gatherWith(t *testing.T, stunServers []string) []pionice.Candidate {
	t.Helper()
	ch := make(chan []string, 1)
	a, err := NewAgent(Config{
		STUNServers: stunServers,
		OnCandidates: func(cands []string) {
			select {
			case ch <- cands:
			default:
			}
		},
	})
	if err != nil {
		t.Fatalf("NewAgent: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })

	if err := a.GatherCandidates(); err != nil {
		t.Fatalf("GatherCandidates: %v", err)
	}

	var raw []string
	select {
	case raw = <-ch:
	case <-time.After(8 * time.Second):
		t.Fatal("timed out waiting for candidate gathering to complete")
	}

	out := make([]pionice.Candidate, 0, len(raw))
	for _, s := range raw {
		c, err := pionice.UnmarshalCandidate(s)
		if err != nil {
			t.Fatalf("unmarshal candidate %q: %v", s, err)
		}
		out = append(out, c)
	}
	return out
}

func countByType(cands []pionice.Candidate, typ pionice.CandidateType) int {
	n := 0
	for _, c := range cands {
		if c.Type() == typ {
			n++
		}
	}
	return n
}

func TestParseSTUNURLs(t *testing.T) {
	got := ParseSTUNURLs([]string{"1.2.3.4:3478", "stun:5.6.7.8:3478"})
	want := []string{"stun:1.2.3.4:3478", "stun:5.6.7.8:3478"}
	if len(got) != len(want) {
		t.Fatalf("len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestAgent_HostCandidatesGathered(t *testing.T) {
	cands := gatherWith(t, nil)
	if len(cands) == 0 {
		t.Skip("no usable network interfaces; skipping host candidate test")
	}
	if got := countByType(cands, pionice.CandidateTypeHost); got == 0 {
		t.Fatalf("expected at least 1 host candidate, got 0 (cands=%v)", cands)
	}
	for _, c := range cands {
		if c.Type() == pionice.CandidateTypeHost && c.Address() == "" {
			t.Errorf("host candidate has empty address")
		}
	}
}

func TestAgent_SrflxAgainstFakeSTUN(t *testing.T) {
	addr, stop := fakeSTUN(t)
	defer stop()

	cands := gatherWith(t, []string{"stun:" + addr.String()})
	if len(cands) == 0 {
		t.Skip("no usable network interfaces; can't reach fake STUN")
	}

	srflxN := countByType(cands, pionice.CandidateTypeServerReflexive)
	if srflxN == 0 {
		t.Fatalf("expected ≥1 srflx candidate from fake STUN, got 0 (cands=%v)", cands)
	}
	// srflx must report a usable mapped address from the local test server.
	for _, c := range cands {
		if c.Type() != pionice.CandidateTypeServerReflexive {
			continue
		}
		ip := net.ParseIP(c.Address())
		if ip == nil {
			t.Errorf("srflx candidate address %q not an IP", c.Address())
		}
		if r := c.RelatedAddress(); r == nil || r.Address == "" {
			t.Errorf("srflx candidate missing related (host) address")
		}
	}
}

func TestAgent_STUNUnreachable_NoSrflxNoPanic(t *testing.T) {
	// Bind+close to grab a port nothing listens on.
	tmp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: localSTUNIP(t), Port: 0})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	dead := tmp.LocalAddr().(*net.UDPAddr).String()
	_ = tmp.Close()

	cands := gatherWith(t, []string{"stun:" + dead})
	if len(cands) == 0 {
		t.Skip("no usable network interfaces")
	}
	if got := countByType(cands, pionice.CandidateTypeHost); got == 0 {
		t.Fatalf("host candidates should still be gathered when STUN is dead, got 0")
	}
	if got := countByType(cands, pionice.CandidateTypeServerReflexive); got != 0 {
		// pion may eventually time out and produce nothing; if it somehow did
		// fabricate one, that would be a real bug.
		t.Fatalf("expected 0 srflx with unreachable STUN, got %d", got)
	}
}

func TestAgent_PriorityOrdering(t *testing.T) {
	addr, stop := fakeSTUN(t)
	defer stop()

	cands := gatherWith(t, []string{"stun:" + addr.String()})
	if len(cands) == 0 {
		t.Skip("no usable network interfaces")
	}

	// Sort by priority desc and verify type-preference invariants from
	// RFC 8445 §5.1.2.2: host > srflx > relay (relay not exercised here).
	sort.Slice(cands, func(i, j int) bool {
		return cands[i].Priority() > cands[j].Priority()
	})

	// Find the highest-priority srflx and host; host's must be ≥ srflx's.
	var hostMax, srflxMax uint32
	for _, c := range cands {
		switch c.Type() {
		case pionice.CandidateTypeHost:
			if c.Priority() > hostMax {
				hostMax = c.Priority()
			}
		case pionice.CandidateTypeServerReflexive:
			if c.Priority() > srflxMax {
				srflxMax = c.Priority()
			}
		}
	}
	if hostMax == 0 {
		t.Skip("no host candidates")
	}
	if srflxMax == 0 {
		t.Fatal("no server-reflexive candidates to compare with host priority")
	}
	if hostMax <= srflxMax {
		t.Fatalf("host priority %d should exceed srflx priority %d", hostMax, srflxMax)
	}
}

func TestAgent_MultipleSTUNServers(t *testing.T) {
	a1, stop1 := fakeSTUN(t)
	defer stop1()
	a2, stop2 := fakeSTUN(t)
	defer stop2()

	cands := gatherWith(t, []string{"stun:" + a1.String(), "stun:" + a2.String()})
	if len(cands) == 0 {
		t.Skip("no usable network interfaces")
	}
	if got := countByType(cands, pionice.CandidateTypeServerReflexive); got == 0 {
		t.Fatalf("expected srflx candidates from two reachable STUN servers, got 0")
	}
}

func TestAgent_CandidateDeduplication(t *testing.T) {
	addr, stop := fakeSTUN(t)
	defer stop()

	cands := gatherWith(t, []string{"stun:" + addr.String()})
	if len(cands) == 0 {
		t.Skip("no usable network interfaces")
	}

	// (type, addr, port, component) tuple should be unique across the slice.
	seen := make(map[string]int)
	for _, c := range cands {
		key := c.Type().String() + "|" + c.Address() + "|" +
			itoa(c.Port()) + "|" + itoa(int(c.Component()))
		seen[key]++
	}
	for k, n := range seen {
		if n > 1 {
			t.Errorf("duplicate candidate tuple %q seen %d times", k, n)
		}
	}
}

func TestAgent_RejectsUnsafeRemoteCandidates(t *testing.T) {
	a, err := NewAgent(Config{})
	if err != nil {
		t.Fatalf("NewAgent: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })

	cases := []string{
		// candidate-attribute syntax: foundation comp proto prio addr port typ host
		"candidate:1 1 udp 2130706431 127.0.0.1 50000 typ host",
		"candidate:2 1 udp 2130706431 169.254.1.2 50000 typ host",
	}
	for _, line := range cases {
		err := a.AddRemoteCandidate(line)
		if err == nil || !strings.Contains(err.Error(), "unsafe") {
			t.Errorf("AddRemoteCandidate(%q) = %v, want unsafe-rejection error", line, err)
		}
	}
}

// itoa is a tiny dep-free int->string for stable map keys.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}
