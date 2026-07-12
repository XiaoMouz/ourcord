// ourcord-cli — command-line interface to the OurCord VPN daemon.
//
// This is a thin presenter: it parses arguments and formats output, delegating
// every daemon operation to the UI-agnostic core in daemon/pkg/client so a TUI
// or GUI can reuse the same logic. Do not add IPC/business logic here.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/ourcord/ourcord/daemon/pkg/client"
	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "enroll", "devices", "revoke-device":
			os.Exit(runDeviceCommand(os.Args[1], os.Args[2:]))
		case "diagnostics":
			os.Exit(runDiagnosticsCommand(os.Args[2:]))
		}
	}

	socketPath := flag.String("socket", ipc.DefaultSocketPath(), "Unix socket path")
	flag.Parse()

	args := flag.Args()
	if len(args) == 0 {
		usage()
		os.Exit(1)
	}
	if args[0] == "watch" {
		os.Exit(runWatch(*socketPath, args[1:]))
	}
	os.Exit(runDaemonCommand(*socketPath, args))
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: ourcord-cli [--socket path] <command> [args...]")
	fmt.Fprintln(os.Stderr, "Commands: status, connect, disconnect, ping, peers, watch [interval_secs], enter-room <room_id>, leave-room, enter-network <network_id>, leave-network, force-derp <peer_public_key> [reason], enroll, devices, revoke-device <device_id>, diagnostics collect")
}

// runDaemonCommand dispatches the IPC-backed commands. Argument arity is checked
// before dialing so a usage error doesn't require a running daemon.
func runDaemonCommand(socketPath string, args []string) int {
	cmd := args[0]
	needsArg := map[string]string{"enter-room": "room_id", "enter-network": "network_id", "force-derp": "peer_public_key"}
	if label, ok := needsArg[cmd]; ok && len(args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: ourcord-cli %s <%s>\n", cmd, label)
		return 1
	}

	cli, err := client.Dial(socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: could not connect to daemon (%s): %v\nIs ourcordd running?\n", socketPath, err)
		return 1
	}
	defer cli.Close()

	switch cmd {
	case "status":
		return emitJSON(cli.Status())
	case "peers":
		return emitJSON(cli.ListPeers())
	case "connect":
		return emitOK(cli.Connect())
	case "disconnect":
		return emitOK(cli.Disconnect())
	case "ping":
		return emitOK(cli.Ping())
	case "enter-room":
		return emitOK(cli.EnterRoom(args[1]))
	case "leave-room":
		return emitOK(cli.LeaveRoom())
	case "enter-network":
		return emitOK(cli.EnterNetwork(args[1]))
	case "leave-network":
		return emitOK(cli.LeaveNetwork())
	case "force-derp":
		reason := ""
		if len(args) >= 3 {
			reason = args[2]
		}
		return emitOK(cli.ForceDERP(args[1], reason))
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		return 1
	}
}

// emitJSON prints a typed result as indented JSON, or the error to stderr.
func emitJSON[T any](v T, err error) int {
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}
	out, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(out))
	return 0
}

// emitOK reports a mutating command's outcome via exit code (silent on success).
func emitOK(err error) int {
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return 1
	}
	return 0
}
