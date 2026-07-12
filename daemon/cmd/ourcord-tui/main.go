// ourcord-tui — an interactive terminal UI for the OurCord VPN daemon.
//
// It is a presenter over daemon/pkg/client: the live view comes from
// client.Watch and every action calls a typed client method, so the TUI shares
// its entire core with ourcord-cli (and any future GUI) — no duplicated
// daemon-control logic.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func main() {
	socket := flag.String("socket", ipc.DefaultSocketPath(), "daemon IPC socket path")
	interval := flag.Duration("interval", 2*time.Second, "status poll interval")
	flag.Parse()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub := client.Watch(ctx, *socket, *interval)

	p := tea.NewProgram(newModel(*socket, sub), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "tui:", err)
		os.Exit(1)
	}
}
