package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ourcord/ourcord/daemon/pkg/client"
)

func pressRune(m model, r rune) model {
	u, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	return u.(model)
}

func TestDevicesViewRequiresToken(t *testing.T) {
	m := pressRune(newModel("/tmp/x.sock", "https://c", "", nil), 'D')
	if m.view != viewDevices {
		t.Fatal("D should switch to the devices view")
	}
	if !strings.Contains(m.View(), "OURCORD_USER_JWT") {
		t.Fatalf("expected the missing-token hint:\n%s", m.View())
	}
	// esc returns to the network view.
	u, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if u.(model).view != viewNet {
		t.Fatal("esc should return to the network view")
	}
}

func TestDevicesViewLoadsAndNavigates(t *testing.T) {
	// With a token, entering the devices view issues a load command.
	m := newModel("/tmp/x.sock", "https://c", "user-jwt", nil)
	u, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'D'}})
	m = u.(model)
	if m.view != viewDevices || !m.devLoading || cmd == nil {
		t.Fatalf("D with token should load devices (loading=%v cmd=%v)", m.devLoading, cmd)
	}
	// The load result populates the list and renders.
	u, _ = m.Update(devicesMsg{devices: []client.DeviceRecord{{ID: "dev-1", Name: "laptop", PublicKey: "pk1"}, {ID: "dev-2", Name: "phone", PublicKey: "pk2"}}})
	m = u.(model)
	if m.devLoading || len(m.devices) != 2 {
		t.Fatalf("devicesMsg should populate and stop loading: %+v", m.devices)
	}
	view := m.View()
	if !strings.Contains(view, "laptop") || !strings.Contains(view, "phone") {
		t.Fatalf("devices view missing entries:\n%s", view)
	}
	// j moves the cursor down; x on a selection issues revoke+reload.
	m = pressRune(m, 'j')
	if m.devCursor != 1 {
		t.Fatalf("cursor = %d, want 1", m.devCursor)
	}
	_, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}})
	if cmd == nil {
		t.Fatal("x on a device should issue a revoke command")
	}
}
