package routing

import (
	"net/netip"
	"strings"
	"testing"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

func mustKey(t *testing.T, b byte) wgtypes.Key {
	t.Helper()
	var k wgtypes.Key
	for i := range k {
		k[i] = b
	}
	return k
}

func mustAddr(t *testing.T, s string) netip.Addr {
	t.Helper()
	a, err := netip.ParseAddr(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return a
}

func mustAddrPort(t *testing.T, s string) *netip.AddrPort {
	t.Helper()
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return &ap
}

// TestBuildIPCConfig_AllowedIPPerLine is the regression test for F1 — the
// WireGuard UAPI requires one allowed_ip per line; comma-joined lists were
// silently rejected and broke chain routing.
func TestBuildIPCConfig_AllowedIPPerLine(t *testing.T) {
	tbl := NewTable()
	priv, _ := wgtypes.GeneratePrivateKey()
	pub := mustKey(t, 0xAA)
	tbl.Upsert(&PeerRoute{
		PublicKey: pub,
		VPN4:      mustAddr(t, "198.18.0.10"),
		VPN6:      mustAddr(t, "fdab::10"),
	})

	got := tbl.BuildIPCConfig(priv)

	// Must have two distinct allowed_ip lines, never a comma.
	if strings.Contains(got, "allowed_ip=198.18.0.10/32,") || strings.Contains(got, ",fdab::10/128") {
		t.Fatalf("comma-joined allowed_ip detected:\n%s", got)
	}
	if c := strings.Count(got, "allowed_ip="); c != 2 {
		t.Fatalf("want 2 allowed_ip lines, got %d:\n%s", c, got)
	}
	if !strings.Contains(got, "allowed_ip=198.18.0.10/32\n") {
		t.Errorf("missing v4 line:\n%s", got)
	}
	if !strings.Contains(got, "allowed_ip=fdab::10/128\n") {
		t.Errorf("missing v6 line:\n%s", got)
	}
}

func TestBuildIPCConfig_DirectPeerEmitsEndpoint(t *testing.T) {
	tbl := NewTable()
	priv, _ := wgtypes.GeneratePrivateKey()
	tbl.Upsert(&PeerRoute{
		PublicKey:  mustKey(t, 0xBB),
		VPN4:       mustAddr(t, "198.18.0.20"),
		DirectAddr: mustAddrPort(t, "203.0.113.5:51820"),
	})
	got := tbl.BuildIPCConfig(priv)
	if !strings.Contains(got, "endpoint=203.0.113.5:51820\n") {
		t.Errorf("expected endpoint line:\n%s", got)
	}
	if !strings.Contains(got, "persistent_keepalive_interval=25\n") {
		t.Errorf("expected keepalive line:\n%s", got)
	}
}

func TestBuildIPCConfig_IndirectPeerNoEndpoint(t *testing.T) {
	tbl := NewTable()
	priv, _ := wgtypes.GeneratePrivateKey()
	hop := mustKey(t, 0xCC)
	tbl.Upsert(&PeerRoute{
		PublicKey:  mustKey(t, 0xDD),
		VPN4:       mustAddr(t, "198.18.0.30"),
		NextHop:    &hop,
		DirectAddr: mustAddrPort(t, "203.0.113.5:51820"), // ignored: NextHop != nil
	})
	got := tbl.BuildIPCConfig(priv)
	if strings.Contains(got, "endpoint=") {
		t.Errorf("indirect peer must not emit endpoint:\n%s", got)
	}
}

func TestAddRelayChainRoutes_TwoPeers(t *testing.T) {
	tbl := NewTable()
	hopKey := mustKey(t, 0xCC) // B is hop for both A and C reaching each other
	// Peer A is reached via hopKey
	tbl.Upsert(&PeerRoute{
		PublicKey: mustKey(t, 0xAA),
		VPN4:      mustAddr(t, "198.18.0.10"),
		VPN6:      mustAddr(t, "fdab::10"),
		NextHop:   &hopKey,
	})
	// Peer C is reached via hopKey
	tbl.Upsert(&PeerRoute{
		PublicKey: mustKey(t, 0xEE),
		VPN4:      mustAddr(t, "198.18.0.30"),
		NextHop:   &hopKey,
	})
	// Peer B (the hop) itself
	tbl.Upsert(&PeerRoute{
		PublicKey: hopKey,
		VPN4:      mustAddr(t, "198.18.0.20"),
	})

	chain := tbl.AddRelayChainRoutes()
	extras := chain[hopKey.String()]
	if len(extras) != 3 {
		t.Fatalf("hop should forward 3 CIDRs (A v4+v6, C v4); got %d: %v", len(extras), extras)
	}
}

func TestAddRelayChainRoutes_DirectPeersIgnored(t *testing.T) {
	tbl := NewTable()
	tbl.Upsert(&PeerRoute{
		PublicKey:  mustKey(t, 0xAA),
		VPN4:       mustAddr(t, "198.18.0.10"),
		DirectAddr: mustAddrPort(t, "203.0.113.1:51820"),
	})
	chain := tbl.AddRelayChainRoutes()
	if len(chain) != 0 {
		t.Errorf("expected empty chain map, got %v", chain)
	}
}

func TestUpsertRemove(t *testing.T) {
	tbl := NewTable()
	pk := mustKey(t, 0x01)
	tbl.Upsert(&PeerRoute{PublicKey: pk, VPN4: mustAddr(t, "198.18.0.1")})
	if len(tbl.All()) != 1 {
		t.Fatalf("expected 1 route")
	}
	tbl.Remove(pk)
	if len(tbl.All()) != 0 {
		t.Fatalf("expected 0 routes after remove")
	}
}

func TestReplaceDropsStaleRoutes(t *testing.T) {
	tbl := NewTable()
	oldKey := mustKey(t, 0x01)
	newKey := mustKey(t, 0x02)
	tbl.Upsert(&PeerRoute{PublicKey: oldKey, VPN4: mustAddr(t, "198.18.0.1")})

	tbl.Replace([]*PeerRoute{{PublicKey: newKey, VPN4: mustAddr(t, "198.18.0.2")}})

	routes := tbl.All()
	if len(routes) != 1 {
		t.Fatalf("expected one route after replace, got %d", len(routes))
	}
	if routes[0].PublicKey != newKey {
		t.Fatalf("expected new route only, got %v", routes[0].PublicKey)
	}
}
