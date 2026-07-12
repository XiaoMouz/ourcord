package main

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

// The peer-detail screen is pure presentation over the ConnectedPeer already in
// the live snapshot — no extra daemon call. It looks the peer up by public key
// each render so it tracks the live Watch stream (and shows a notice if the peer
// leaves the network).

func (m model) handlePeerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "q":
		return m, tea.Quit
	case "esc", "enter":
		m.view = viewNet
	}
	return m, nil
}

func (m model) selectedPeer() (ipc.ConnectedPeer, bool) {
	for _, p := range m.snap.Peers {
		if p.PublicKey == m.peerKey {
			return p, true
		}
	}
	return ipc.ConnectedPeer{}, false
}

func (m model) peerDetailView() string {
	var b strings.Builder
	b.WriteString(titleStyle.Render("OurCord — peer") + "\n\n")

	p, ok := m.selectedPeer()
	if !ok {
		b.WriteString(labelStyle.Render("(peer no longer present)") + "\n")
		b.WriteString("\n" + helpStyle.Render("[esc] back  [q]uit"))
		return b.String()
	}

	rows := [][2]string{
		{"name", dash(p.Name)},
		{"public key", dash(p.PublicKey)},
		{"ipv4", dash(p.IP4)},
		{"ipv6", dash(p.IP6)},
		{"path", dash(p.Path)},
		{"direct", boolWord(p.Direct, "yes", "no")},
		{"endpoint", dash(p.Endpoint)},
		{"candidate", dash(p.CandidateEndpoint)},
		{"relay", dash(p.RelayURL)},
		{"next hop", dash(p.NextHop)},
		{"latency", fmt.Sprintf("%.1f ms", p.LatencyMs)},
		{"last seen", fmt.Sprintf("%ds", p.LastSeenSecs)},
		{"transitions", fmt.Sprintf("%d", p.PathTransitions)},
		{"dwell", fmt.Sprintf("%ds", p.PathDwellSecs)},
		{"flapping", boolWord(p.Flapping, "yes", "no")},
		{"last error", dash(p.LastError)},
	}
	for _, r := range rows {
		b.WriteString(labelStyle.Render(fmt.Sprintf("%-12s", r[0])) + " " + r[1] + "\n")
	}

	b.WriteString("\n" + helpStyle.Render("[esc]/[enter] back  [q]uit"))
	return b.String()
}
