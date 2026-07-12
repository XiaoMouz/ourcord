package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ourcord/ourcord/daemon/pkg/client"
)

// The device screen reuses the same control-plane core the CLI uses
// (client.ListDevices / client.RevokeDevice) — the TUI adds only navigation and
// rendering. Auth is the one-time user JWT from --user-token / OURCORD_USER_JWT.

type devicesMsg struct {
	devices []client.DeviceRecord
	err     error
}

func loadDevicesCmd(controlURL, token string) tea.Cmd {
	return func() tea.Msg {
		devs, err := client.ListDevices(context.Background(), http.DefaultClient, controlURL, token)
		return devicesMsg{devices: devs, err: err}
	}
}

func revokeDeviceCmd(controlURL, token, id string) tea.Cmd {
	return func() tea.Msg {
		return actionMsg{"revoke " + short(id), client.RevokeDevice(context.Background(), http.DefaultClient, controlURL, token, id)}
	}
}

func (m model) handleDevicesKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc", "D", "q":
		m.view, m.msg = viewNet, ""
		return m, nil
	case "j", "down":
		if m.devCursor < len(m.devices)-1 {
			m.devCursor++
		}
	case "k", "up":
		if m.devCursor > 0 {
			m.devCursor--
		}
	case "r":
		if m.userToken != "" {
			m.devLoading = true
			return m, loadDevicesCmd(m.controlURL, m.userToken)
		}
	case "x":
		if m.userToken != "" && m.devCursor >= 0 && m.devCursor < len(m.devices) {
			id := m.devices[m.devCursor].ID
			// Revoke, then reload so the list reflects the new state.
			return m, tea.Batch(revokeDeviceCmd(m.controlURL, m.userToken, id), loadDevicesCmd(m.controlURL, m.userToken))
		}
	}
	return m, nil
}

func (m model) devicesView() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("OurCord — devices") + "\n\n")

	switch {
	case m.userToken == "":
		b.WriteString(errStyle.Render("set OURCORD_USER_JWT (or --user-token) to manage devices") + "\n")
	case m.devLoading:
		b.WriteString(labelStyle.Render("loading…") + "\n")
	case m.devErr != nil:
		b.WriteString(errStyle.Render("error: "+m.devErr.Error()) + "\n")
	case len(m.devices) == 0:
		b.WriteString(labelStyle.Render("(no devices)") + "\n")
	default:
		b.WriteString(headerStyle.Render(fmt.Sprintf("  %-14s %-16s %-8s %s", "ID", "NAME", "STATUS", "PUBLIC KEY")) + "\n")
		for i, d := range m.devices {
			cursor := "  "
			status := "active"
			if d.RevokedAt != nil {
				status = "revoked"
			}
			line := fmt.Sprintf("%s%-14s %-16s %-8s %s", cursor, truncate(d.ID, 14), truncate(d.Name, 16), status, short(d.PublicKey))
			if i == m.devCursor {
				line = okStyle.Render("▶ " + line[2:])
			}
			b.WriteString(line + "\n")
		}
	}

	if m.msg != "" {
		style := okStyle
		if !strings.HasSuffix(m.msg, ": ok") {
			style = errStyle
		}
		b.WriteString("\n" + style.Render(m.msg) + "\n")
	}
	b.WriteString("\n" + helpStyle.Render("[j/k] move  [x] revoke  [r] refresh  [D]/[esc] back  [q]uit"))
	return b.String()
}

func truncate(s string, n int) string {
	if s == "" {
		return "-"
	}
	if len(s) > n {
		return s[:n-1] + "…"
	}
	return s
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
