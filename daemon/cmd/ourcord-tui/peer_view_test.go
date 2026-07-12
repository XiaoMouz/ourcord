package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func netModelWithPeers(peers ...ipc.ConnectedPeer) model {
	m := newModel("/tmp/x.sock", "", "", nil)
	u, _ := m.Update(snapshotMsg(client.Snapshot{
		Status: ipc.DaemonStatus{VPNActive: true},
		Peers:  peers,
	}))
	return u.(model)
}

func TestPeerSelectAndDetailView(t *testing.T) {
	m := netModelWithPeers(
		ipc.ConnectedPeer{PublicKey: "pkA", IP4: "198.18.0.2", Path: "direct", Direct: true},
		ipc.ConnectedPeer{PublicKey: "pkB", IP4: "198.18.0.3", Path: "next-hop", NextHop: "pkA", PathTransitions: 4, Flapping: true, LastError: "direct-health-lost"},
	)
	// j moves the cursor to the second peer; enter opens its detail.
	m = pressRune(m, 'j')
	if m.peerCursor != 1 {
		t.Fatalf("cursor = %d, want 1", m.peerCursor)
	}
	u, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = u.(model)
	if m.view != viewPeer || m.peerKey != "pkB" {
		t.Fatalf("enter should open peer pkB detail (view=%s key=%s)", m.view, m.peerKey)
	}
	view := m.View()
	for _, want := range []string{"198.18.0.3", "next-hop", "direct-health-lost", "transitions", "flapping"} {
		if !strings.Contains(view, want) {
			t.Fatalf("peer detail missing %q:\n%s", want, view)
		}
	}
	// esc returns to the network view.
	u, _ = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if u.(model).view != viewNet {
		t.Fatal("esc should return to the network view")
	}
}

func TestPeerDetailHandlesDepartedPeer(t *testing.T) {
	m := netModelWithPeers(ipc.ConnectedPeer{PublicKey: "pkA", IP4: "198.18.0.2"})
	u, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = u.(model)
	// The peer leaves the network on the next snapshot; detail must not panic
	// and should say so, and the cursor must stay in range.
	u, _ = m.Update(snapshotMsg(client.Snapshot{Peers: nil}))
	m = u.(model)
	if m.peerCursor != 0 {
		t.Fatalf("cursor should clamp to 0, got %d", m.peerCursor)
	}
	if !strings.Contains(m.View(), "no longer present") {
		t.Fatalf("expected departed-peer notice:\n%s", m.View())
	}
}
