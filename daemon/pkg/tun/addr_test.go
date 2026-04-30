package tun

import (
	"bytes"
	"fmt"
	"net/netip"
	"testing"
)

// fakeConfigurator is a recording AddrConfigurator used by the tests
// below. It captures every (op, ifname, args...) tuple in Calls so we
// can assert on ordering, idempotency, and absence of duplicates
// without exec'ing anything against the host kernel.
type fakeConfigurator struct {
	// installed mirrors the kernel route table the OS impl would
	// observe via `ip route show` — fakeConfigurator updates it on
	// SyncPeerV4Routes so consecutive calls are realistically idempotent.
	installed map[netip.Addr]struct{}
	calls     []fakeCall
	// failOn, if non-nil, returns its error from the matching op name
	// so we can exercise error paths.
	failOn map[string]error
}

type fakeCall struct {
	op     string // "AssignAddrs" | "AddRoute" | "DelRoute"
	ifname string
	addr   string // "" for AssignAddrs (use prefixes instead)
	prefs  []string
}

func newFake() *fakeConfigurator {
	return &fakeConfigurator{installed: map[netip.Addr]struct{}{}}
}

func (f *fakeConfigurator) AssignAddrs(ifname string, addrs []netip.Prefix) error {
	if err := f.failOn["AssignAddrs"]; err != nil {
		return err
	}
	c := fakeCall{op: "AssignAddrs", ifname: ifname}
	for _, a := range addrs {
		c.prefs = append(c.prefs, a.String())
	}
	f.calls = append(f.calls, c)
	return nil
}

func (f *fakeConfigurator) SyncPeerV4Routes(ifname string, want []netip.Addr) error {
	if err := f.failOn["SyncPeerV4Routes"]; err != nil {
		return err
	}
	toAdd, toDel := DiffV4Routes(f.installed, want)
	for _, a := range toAdd {
		f.installed[a] = struct{}{}
		f.calls = append(f.calls, fakeCall{op: "AddRoute", ifname: ifname, addr: a.String()})
	}
	for _, a := range toDel {
		delete(f.installed, a)
		f.calls = append(f.calls, fakeCall{op: "DelRoute", ifname: ifname, addr: a.String()})
	}
	return nil
}

func (f *fakeConfigurator) opsFor(op string) []string {
	var out []string
	for _, c := range f.calls {
		if c.op == op {
			out = append(out, c.addr)
		}
	}
	return out
}

// addrs is a tiny helper to build a slice of v4 addrs for tests.
func addrs(t *testing.T, ss ...string) []netip.Addr {
	t.Helper()
	out := make([]netip.Addr, len(ss))
	for i, s := range ss {
		a, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", s, err)
		}
		out[i] = a
	}
	return out
}

// --- 1. Single peer /32 route added correctly ----------------------------

func TestSyncPeerV4Routes_SinglePeerAdded(t *testing.T) {
	t.Parallel()
	f := newFake()
	if err := f.SyncPeerV4Routes("tun0", addrs(t, "198.18.0.10")); err != nil {
		t.Fatalf("sync: %v", err)
	}
	got := f.opsFor("AddRoute")
	if len(got) != 1 || got[0] != "198.18.0.10" {
		t.Fatalf("expected single AddRoute for 198.18.0.10, got %v", got)
	}
	if _, ok := f.installed[netip.MustParseAddr("198.18.0.10")]; !ok {
		t.Fatalf("route was not recorded as installed")
	}
}

// --- 2. Multiple peers — routes added in order, no duplicates ------------

func TestSyncPeerV4Routes_MultiplePeersDeterministicAndDeduped(t *testing.T) {
	t.Parallel()
	f := newFake()
	// Intentionally unsorted with a duplicate: DiffV4Routes must
	// dedupe and return results in ascending order.
	in := addrs(t, "198.18.0.20", "198.18.0.5", "198.18.0.10", "198.18.0.10")
	if err := f.SyncPeerV4Routes("tun0", in); err != nil {
		t.Fatalf("sync: %v", err)
	}
	got := f.opsFor("AddRoute")
	want := []string{"198.18.0.5", "198.18.0.10", "198.18.0.20"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("AddRoute order mismatch: got %v want %v", got, want)
	}
	if len(f.installed) != 3 {
		t.Fatalf("expected 3 installed routes, got %d", len(f.installed))
	}
}

// --- 3. Peer removed — route removed -------------------------------------

func TestSyncPeerV4Routes_PeerRemoved(t *testing.T) {
	t.Parallel()
	f := newFake()
	if err := f.SyncPeerV4Routes("tun0", addrs(t, "198.18.0.1", "198.18.0.2", "198.18.0.3")); err != nil {
		t.Fatalf("initial sync: %v", err)
	}
	// Drop .2 from the desired set; expect one DelRoute and no spurious AddRoute.
	startCalls := len(f.calls)
	if err := f.SyncPeerV4Routes("tun0", addrs(t, "198.18.0.1", "198.18.0.3")); err != nil {
		t.Fatalf("second sync: %v", err)
	}
	delta := f.calls[startCalls:]
	if len(delta) != 1 || delta[0].op != "DelRoute" || delta[0].addr != "198.18.0.2" {
		t.Fatalf("expected single DelRoute for .2, got %+v", delta)
	}
	if _, gone := f.installed[netip.MustParseAddr("198.18.0.2")]; gone {
		t.Fatalf(".2 still installed after removal")
	}
}

// --- 4. Addr parse — accept valid 198.18.x.x, reject out-of-range --------

func TestIsValidVPNv4(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want bool
	}{
		{"198.18.0.0", true},     // pool start
		{"198.18.0.1", true},     // typical daemon self
		{"198.19.255.255", true}, // pool end (RFC 2544 covers /15)
		{"198.17.255.255", false},
		{"198.20.0.0", false},
		{"10.0.0.1", false},
		{"0.0.0.0", false},
		{"::1", false}, // v6 rejected
	}
	for _, tc := range cases {
		a := netip.MustParseAddr(tc.in)
		if got := IsValidVPNv4(a); got != tc.want {
			t.Errorf("IsValidVPNv4(%s) = %v, want %v", tc.in, got, tc.want)
		}
	}
	var zero netip.Addr
	if IsValidVPNv4(zero) {
		t.Errorf("IsValidVPNv4(zero) should be false")
	}
}

// --- 5a. ULA addr handling (fc00::/7 detection + /48 derivation) ---------

func TestULA48AndDetection(t *testing.T) {
	t.Parallel()
	a := netip.MustParseAddr("fdab:cdef:1234:5678::1")
	if !IsULA(a) {
		t.Fatalf("expected fd:: addr to be ULA")
	}
	got := ULA48(a).String()
	if got != "fdab:cdef:1234::/48" {
		t.Fatalf("ULA48 = %s, want fdab:cdef:1234::/48", got)
	}
	// Non-ULA v6 (link-local) must be rejected.
	if IsULA(netip.MustParseAddr("fe80::1")) {
		t.Errorf("fe80::1 should not be classified ULA")
	}
	// v4 addrs are not ULA.
	if IsULA(netip.MustParseAddr("198.18.0.1")) {
		t.Errorf("v4 addr should not be classified ULA")
	}
}

// --- 5b. ULA random per session — generator picks fd00::/8 + ::1 host ----

func TestGenerateSessionULA(t *testing.T) {
	t.Parallel()
	// Deterministic byte source so the test is reproducible.
	src := bytes.NewReader([]byte{0xaa, 0x11, 0x22, 0x33, 0x44, 0x55})
	a, err := GenerateSessionULA(src)
	if err != nil {
		t.Fatalf("GenerateSessionULA: %v", err)
	}
	if !IsULA(a) {
		t.Fatalf("generated %s is not a ULA", a)
	}
	b := a.As16()
	if b[0] != 0xfd {
		t.Errorf("first byte = %#x, want 0xfd (RFC 4193 locally assigned)", b[0])
	}
	if b[15] != 0x01 {
		t.Errorf("host suffix = %#x, want 0x01", b[15])
	}
	// Two sessions with different entropy must yield different addrs.
	src2 := bytes.NewReader([]byte{0xaa, 0x11, 0x22, 0x33, 0x44, 0x56})
	a2, err := GenerateSessionULA(src2)
	if err != nil {
		t.Fatalf("GenerateSessionULA #2: %v", err)
	}
	if a == a2 {
		t.Errorf("expected distinct ULAs across sessions, got %s twice", a)
	}
	// Underflowing entropy must surface as an error, not a partial addr.
	if _, err := GenerateSessionULA(bytes.NewReader([]byte{0x00})); err == nil {
		t.Errorf("expected error for short entropy, got nil")
	}
}

// --- 6. Idempotent re-application ----------------------------------------

func TestSyncPeerV4Routes_Idempotent(t *testing.T) {
	t.Parallel()
	f := newFake()
	want := addrs(t, "198.18.1.1", "198.18.1.2", "198.18.1.3")
	if err := f.SyncPeerV4Routes("tun0", want); err != nil {
		t.Fatalf("first sync: %v", err)
	}
	first := len(f.calls)
	// Re-applying the same desired state must produce zero new calls.
	for i := 0; i < 3; i++ {
		if err := f.SyncPeerV4Routes("tun0", want); err != nil {
			t.Fatalf("re-sync %d: %v", i, err)
		}
	}
	if len(f.calls) != first {
		t.Fatalf("expected idempotent re-sync, but calls grew %d -> %d (%v)", first, len(f.calls), f.calls[first:])
	}
}

// Bonus: invalid / non-v4 addrs in `want` are silently dropped — they
// would otherwise crash the OS impl when stringified into `ip route add`.
func TestDiffV4Routes_DropsInvalidAndV6(t *testing.T) {
	t.Parallel()
	want := []netip.Addr{
		netip.MustParseAddr("198.18.0.1"),
		netip.MustParseAddr("fdab::1"), // v6, must be ignored
		{},                              // zero addr, must be ignored
	}
	add, del := DiffV4Routes(map[netip.Addr]struct{}{}, want)
	if len(add) != 1 || add[0].String() != "198.18.0.1" {
		t.Fatalf("toAdd = %v, want [198.18.0.1]", add)
	}
	if len(del) != 0 {
		t.Fatalf("toDel = %v, want []", del)
	}
}

// Sanity: OSConfigurator satisfies AddrConfigurator at compile time.
var _ AddrConfigurator = OSConfigurator{}

// Smoke test for the doc-promised "AddrConfigurator" name in case future
// refactors rename it — the daemon's IPC layer depends on the symbol.
func TestAddrConfiguratorInterfaceShape(t *testing.T) {
	t.Parallel()
	var c AddrConfigurator = newFake()
	if err := c.AssignAddrs("tun0", []netip.Prefix{netip.MustParsePrefix("198.18.0.1/32")}); err != nil {
		t.Fatalf("AssignAddrs: %v", err)
	}
	if err := c.SyncPeerV4Routes("tun0", addrs(t, "198.18.0.1")); err != nil {
		t.Fatalf("SyncPeerV4Routes: %v", err)
	}
	// Make sure the recording fake actually saw an AssignAddrs call too.
	f := c.(*fakeConfigurator)
	var sawAssign bool
	for _, k := range f.calls {
		if k.op == "AssignAddrs" && len(k.prefs) == 1 && k.prefs[0] == "198.18.0.1/32" {
			sawAssign = true
		}
	}
	if !sawAssign {
		t.Fatalf("AssignAddrs not recorded; calls=%v", f.calls)
	}
}
