package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func TestSnapshotMsgUpdatesModel(t *testing.T) {
	m := newModel("/tmp/x.sock", nil)
	updated, _ := m.Update(snapshotMsg(client.Snapshot{
		Status: ipc.DaemonStatus{VPNActive: true, IP4: "198.18.0.2", PathSummary: "direct"},
		Peers:  []ipc.ConnectedPeer{{IP4: "198.18.0.3", Path: "direct", Direct: true}},
	}))
	mm := updated.(model)
	if !mm.haveSnap || !mm.snap.Status.VPNActive {
		t.Fatalf("snapshot not applied: %+v", mm.snap)
	}
	view := mm.View()
	if !strings.Contains(view, "198.18.0.2") || !strings.Contains(view, "198.18.0.3") {
		t.Fatalf("view missing status/peer data:\n%s", view)
	}
}

func TestEnterNetworkInputMode(t *testing.T) {
	m := newModel("/tmp/x.sock", nil)
	// 'n' opens the input prompt.
	u, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	m = u.(model)
	if !m.entering {
		t.Fatal("pressing n should enter network-input mode")
	}
	// Typed runes accumulate; the view shows the prompt.
	for _, r := range "lobby-x-voice" {
		u, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		m = u.(model)
	}
	if m.input != "lobby-x-voice" {
		t.Fatalf("input = %q, want lobby-x-voice", m.input)
	}
	if !strings.Contains(m.View(), "enter network id: lobby-x-voice") {
		t.Fatalf("view missing input prompt:\n%s", m.View())
	}
	// Enter submits (returns a command) and leaves input mode.
	u, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = u.(model)
	if m.entering || cmd == nil {
		t.Fatalf("enter should submit and issue a command (entering=%v cmd=%v)", m.entering, cmd)
	}
	// Esc from a fresh prompt cancels without a command.
	m.entering, m.input = true, "partial"
	u, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	m = u.(model)
	if m.entering || m.input != "" {
		t.Fatal("esc should cancel input mode")
	}
}

func TestQuitKey(t *testing.T) {
	m := newModel("/tmp/x.sock", nil)
	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd == nil {
		t.Fatal("q should return a quit command")
	}
}

func TestErrorSnapshotRendersUnavailable(t *testing.T) {
	m := newModel("/tmp/x.sock", nil)
	u, _ := m.Update(snapshotMsg(client.Snapshot{Err: errFake("boom")}))
	if !strings.Contains(u.(model).View(), "daemon unavailable: boom") {
		t.Fatalf("expected unavailable message:\n%s", u.(model).View())
	}
}

type errFake string

func (e errFake) Error() string { return string(e) }
