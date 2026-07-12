package main

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

// The TUI is a thin presenter: all daemon logic comes from daemon/pkg/client
// (Watch for the live view-model, the typed ops for actions). Swapping Bubble
// Tea for another toolkit — or adding a GUI — reuses this same core untouched.

type snapshotMsg client.Snapshot
type streamClosedMsg struct{}
type actionMsg struct {
	label string
	err   error
}

// waitForSnapshot turns the next value from the Watch channel into a tea.Msg;
// re-issued after each snapshot to keep the stream flowing into Update.
func waitForSnapshot(ch <-chan client.Snapshot) tea.Cmd {
	return func() tea.Msg {
		snap, ok := <-ch
		if !ok {
			return streamClosedMsg{}
		}
		return snapshotMsg(snap)
	}
}

// doOp runs a mutating operation on a short-lived client connection off the UI
// goroutine and reports the outcome as an actionMsg.
func doOp(socket, label string, op func(*client.Client) error) tea.Cmd {
	return func() tea.Msg {
		c, err := client.Dial(socket)
		if err != nil {
			return actionMsg{label, err}
		}
		defer c.Close()
		return actionMsg{label, op(c)}
	}
}

type model struct {
	socket     string
	controlURL string
	userToken  string
	sub        <-chan client.Snapshot
	snap       client.Snapshot
	haveSnap   bool
	entering   bool // network-id input mode
	input      string
	msg        string
	width      int

	// network view peer selection
	peerCursor int
	peerKey    string // selected peer (by public key) for the detail view

	// devices view (control-plane device management)
	view       string // viewNet | viewPeer | viewDevices
	devices    []client.DeviceRecord
	devErr     error
	devCursor  int
	devLoading bool
}

const (
	viewNet     = "net"
	viewPeer    = "peer"
	viewDevices = "devices"
)

func newModel(socket, controlURL, userToken string, sub <-chan client.Snapshot) model {
	return model{socket: socket, controlURL: controlURL, userToken: userToken, sub: sub, width: 80, view: viewNet}
}

func (m model) Init() tea.Cmd { return waitForSnapshot(m.sub) }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case snapshotMsg:
		m.snap = client.Snapshot(msg)
		m.haveSnap = true
		if m.peerCursor >= len(m.snap.Peers) { // list shrank under the cursor
			m.peerCursor = maxInt(0, len(m.snap.Peers)-1)
		}
		return m, waitForSnapshot(m.sub) // keep reading the stream
	case streamClosedMsg:
		return m, tea.Quit
	case actionMsg:
		if msg.err != nil {
			m.msg = msg.label + ": " + msg.err.Error()
		} else {
			m.msg = msg.label + ": ok"
		}
		return m, nil
	case devicesMsg:
		m.devices, m.devErr, m.devLoading = msg.devices, msg.err, false
		if m.devCursor >= len(m.devices) {
			m.devCursor = maxInt(0, len(m.devices)-1)
		}
		return m, nil
	case deviceRevokedMsg:
		if msg.err != nil {
			m.msg = "revoke " + short(msg.id) + ": " + msg.err.Error()
			return m, nil
		}
		// Revoke landed — now reload so the list reflects the new state.
		m.msg, m.devLoading = "revoke "+short(msg.id)+": ok", true
		return m, loadDevicesCmd(m.controlURL, m.userToken)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.view == viewDevices {
		return m.handleDevicesKey(msg)
	}
	if m.view == viewPeer {
		return m.handlePeerKey(msg)
	}
	if m.entering {
		switch msg.String() {
		case "esc":
			m.entering, m.input = false, ""
		case "enter":
			id := strings.TrimSpace(m.input)
			m.entering, m.input = false, ""
			if id != "" {
				return m, doOp(m.socket, "enter-network", func(c *client.Client) error { return c.EnterNetwork(id) })
			}
		case "backspace":
			if len(m.input) > 0 {
				m.input = m.input[:len(m.input)-1]
			}
		default:
			if msg.Type == tea.KeyRunes {
				m.input += string(msg.Runes)
			}
		}
		return m, nil
	}
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "c":
		return m, doOp(m.socket, "connect", func(c *client.Client) error { return c.Connect() })
	case "d":
		return m, doOp(m.socket, "disconnect", func(c *client.Client) error { return c.Disconnect() })
	case "l":
		return m, doOp(m.socket, "leave-network", func(c *client.Client) error { return c.LeaveNetwork() })
	case "n":
		m.entering, m.input = true, ""
	case "j", "down":
		if n := len(m.snap.Peers); n > 0 && m.peerCursor < n-1 {
			m.peerCursor++
		}
	case "k", "up":
		if m.peerCursor > 0 {
			m.peerCursor--
		}
	case "enter":
		if m.peerCursor < len(m.snap.Peers) {
			m.peerKey, m.view = m.snap.Peers[m.peerCursor].PublicKey, viewPeer
		}
	case "D":
		m.view, m.devLoading, m.msg = viewDevices, m.userToken != "", ""
		if m.userToken != "" {
			return m, loadDevicesCmd(m.controlURL, m.userToken)
		}
	}
	return m, nil
}

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("6"))
	labelStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("4"))
	errStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	okStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	helpStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
)

func (m model) View() string {
	if m.view == viewDevices {
		return m.devicesView()
	}
	if m.view == viewPeer {
		return m.peerDetailView()
	}
	var b strings.Builder
	b.WriteString(titleStyle.Render("OurCord") + "\n\n")

	switch {
	case !m.haveSnap:
		b.WriteString(labelStyle.Render("connecting to daemon…") + "\n")
	case m.snap.Err != nil:
		b.WriteString(errStyle.Render("daemon unavailable: "+m.snap.Err.Error()) + "\n")
	default:
		s := m.snap.Status
		relay := "off"
		if s.RelayUsed {
			relay = s.RelayURL
		}
		b.WriteString(kv("vpn", boolWord(s.VPNActive, "active", "down")) + "   ")
		b.WriteString(kv("ipv4", dash(s.IP4)) + "   ")
		b.WriteString(kv("path", dash(s.PathSummary)) + "   ")
		b.WriteString(kv("relay", relay) + "\n")
		b.WriteString(kv("network", dash(s.NetworkID)) + "   ")
		b.WriteString(kv("peers", fmt.Sprintf("%d", s.PeerCount)) + "   ")
		b.WriteString(kv("flaps", fmt.Sprintf("%d", s.PathFlapsTotal)) + "\n\n")
		b.WriteString(peerTable(m.snap.Peers, m.peerCursor))
	}

	b.WriteString("\n")
	if m.entering {
		b.WriteString("enter network id: " + m.input + "▏\n")
	} else if m.msg != "" {
		style := okStyle
		if strings.Contains(m.msg, ": ") && !strings.HasSuffix(m.msg, ": ok") {
			style = errStyle
		}
		b.WriteString(style.Render(m.msg) + "\n")
	}
	b.WriteString(helpStyle.Render("[jk] select  [enter] peer detail  [c]onnect  [d]isconnect  [n]etwork  [l]eave  [D]evices  [q]uit"))
	return b.String()
}

func kv(k, v string) string { return labelStyle.Render(k+":") + " " + v }

func peerTable(peers []ipc.ConnectedPeer, cursor int) string {
	if len(peers) == 0 {
		return labelStyle.Render("(no peers)")
	}
	var b strings.Builder
	b.WriteString(headerStyle.Render(fmt.Sprintf("  %-16s %-10s %-7s %-5s %s", "IPV4", "PATH", "DIRECT", "FLAP", "PUBLIC KEY")) + "\n")
	for i, p := range peers {
		flap := ""
		if p.Flapping {
			flap = "yes"
		}
		row := fmt.Sprintf("%-16s %-10s %-7s %-5s %s", dash(p.IP4), dash(p.Path), boolWord(p.Direct, "yes", "no"), flap, short(p.PublicKey))
		if i == cursor {
			b.WriteString(okStyle.Render("▶ "+row) + "\n")
		} else {
			b.WriteString("  " + row + "\n")
		}
	}
	return b.String()
}

func boolWord(b bool, yes, no string) string {
	if b {
		return yes
	}
	return no
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func short(key string) string {
	if len(key) > 20 {
		return key[:20] + "…"
	}
	return key
}
