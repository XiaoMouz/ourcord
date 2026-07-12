package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/client"
)

// runWatch renders a live, read-only status view by consuming client.Watch —
// the same core view-model the TUI uses. Rendering (ANSI, layout) is the
// presenter's job and stays here; the data/poll/reconnect logic stays in core.
func runWatch(socketPath string, args []string) int {
	interval := 2 * time.Second
	if len(args) >= 1 {
		if n, err := strconv.Atoi(args[0]); err == nil && n > 0 {
			interval = time.Duration(n) * time.Second
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	fmt.Print("\x1b[?25l")       // hide cursor while streaming
	defer fmt.Print("\x1b[?25h") // restore on exit
	for snap := range client.Watch(ctx, socketPath, interval) {
		renderSnapshot(os.Stdout, snap)
	}
	return 0
}

func renderSnapshot(w io.Writer, snap client.Snapshot) {
	fmt.Fprint(w, "\x1b[2J\x1b[H") // clear + home
	fmt.Fprintf(w, "ourcord — %s   (Ctrl-C to quit)\n\n", snap.At.Format("15:04:05"))
	if snap.Err != nil {
		fmt.Fprintf(w, "daemon unavailable: %v\n", snap.Err)
		return
	}
	s := snap.Status
	relay := "off"
	if s.RelayUsed {
		relay = s.RelayURL
	}
	fmt.Fprintf(w, "vpn: %s   ipv4: %s   path: %s   relay: %s\n", boolWord(s.VPNActive, "active", "down"), dash(s.IP4), dash(s.PathSummary), relay)
	fmt.Fprintf(w, "network: %s   peers: %d   flaps: %d\n\n", dash(s.NetworkID), s.PeerCount, s.PathFlapsTotal)

	if len(snap.Peers) == 0 {
		fmt.Fprintln(w, "(no peers)")
		return
	}
	fmt.Fprintf(w, "%-16s %-10s %-8s %-6s %s\n", "IPV4", "PATH", "DIRECT", "FLAP", "PUBLIC KEY")
	for _, p := range snap.Peers {
		flap := ""
		if p.Flapping {
			flap = "yes"
		}
		fmt.Fprintf(w, "%-16s %-10s %-8s %-6s %s\n", dash(p.IP4), dash(p.Path), boolWord(p.Direct, "yes", "no"), flap, short(p.PublicKey))
	}
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
	if len(key) > 16 {
		return key[:16] + "…"
	}
	return key
}
