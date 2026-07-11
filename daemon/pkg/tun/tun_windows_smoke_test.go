//go:build windows

package tun

import (
	"net/netip"
	"os"
	"testing"
)

// TestWintunAdapterSmoke drives a real Wintun adapter end-to-end: create it,
// confirm the OS address landed, add and remove a peer /32, and confirm the
// route table follows — exercising the winipcfg path that can't run off-Windows.
// It needs Administrator and wintun.dll on the DLL search path, so it is gated
// behind OURCORD_WINTUN_SMOKE=1 (set in the windows-native CI job).
func TestWintunAdapterSmoke(t *testing.T) {
	if os.Getenv("OURCORD_WINTUN_SMOKE") != "1" {
		t.Skip("set OURCORD_WINTUN_SMOKE=1 (needs admin + wintun.dll) to run the Wintun adapter smoke")
	}
	self := netip.MustParseAddr("198.18.0.2")
	peer := netip.MustParseAddr("198.18.0.3")

	iface, err := New("ourcord-ci-smoke", []netip.Prefix{netip.PrefixFrom(self, 32)})
	if err != nil {
		t.Fatalf("create wintun adapter: %v", err)
	}
	defer iface.Close()

	luid, err := ifaceLUID(iface.Name())
	if err != nil {
		t.Fatalf("resolve luid for %q: %v", iface.Name(), err)
	}

	// assignAddrs must have put the VPN address on the adapter.
	selfSet, err := interfaceSelfV4(luid)
	if err != nil {
		t.Fatalf("read self addresses: %v", err)
	}
	if _, ok := selfSet[self]; !ok {
		t.Fatalf("assigned address %s not found on adapter (have %v)", self, selfSet)
	}

	// Adding a peer /32 must appear in the managed set, and the self address
	// must be excluded from it (the Windows on-link route trap).
	if err := iface.SyncPeerV4Routes([]netip.Addr{peer}); err != nil {
		t.Fatalf("sync add peer route: %v", err)
	}
	have, err := listV4HostRoutes(luid)
	if err != nil {
		t.Fatalf("read host routes: %v", err)
	}
	if _, ok := have[peer]; !ok {
		t.Fatalf("peer route %s not installed (have %v)", peer, have)
	}
	if _, ok := have[self]; ok {
		t.Fatalf("self address %s must be excluded from managed host routes", self)
	}

	// Removing it must drain the route back out (idempotent sync to empty).
	if err := iface.SyncPeerV4Routes(nil); err != nil {
		t.Fatalf("sync remove peer route: %v", err)
	}
	have, err = listV4HostRoutes(luid)
	if err != nil {
		t.Fatalf("read host routes after removal: %v", err)
	}
	if _, ok := have[peer]; ok {
		t.Fatalf("peer route %s should have been removed (have %v)", peer, have)
	}
}
