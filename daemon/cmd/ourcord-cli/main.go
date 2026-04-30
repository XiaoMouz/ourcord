// ourcord-cli — CLI tool for testing OurCord VPN daemon
// Connects to the daemon IPC socket and runs test commands.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
)

func main() {
	var socketPath = flag.String("socket", ipc.DefaultSocketPath(), "Unix socket path")
	flag.Parse()

	args := flag.Args()
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: ourcord-cli [--socket path] <command> [args...]")
		fmt.Fprintln(os.Stderr, "Commands: status, connect, disconnect, ping, peers")
		os.Exit(1)
	}

	client, err := ipc.NewClientWithSecret(*socketPath, loadHMACKeyOrNil())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: could not connect to daemon (%s): %v\n", *socketPath, err)
		fmt.Fprintln(os.Stderr, "Is ourcordd running?")
		os.Exit(1)
	}
	defer client.Close()

	cmd := args[0]
	var cmdName string
	switch cmd {
	case "status":
		cmdName = ipc.CmdStatus
	case "connect":
		cmdName = ipc.CmdConnect
	case "disconnect":
		cmdName = ipc.CmdDisconnect
	case "ping":
		cmdName = ipc.CmdPing
	case "peers":
		cmdName = ipc.CmdListPeers
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		os.Exit(1)
	}

	resp, err := client.Call(cmdName, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "IPC call error: %v\n", err)
		os.Exit(1)
	}

	if !resp.OK {
		fmt.Fprintf(os.Stderr, "Error: %s\n", resp.Error)
		os.Exit(1)
	}

	out, _ := json.MarshalIndent(resp.Data, "", "  ")
	fmt.Println(string(out))
}

// loadHMACKeyOrNil returns the shared IPC HMAC secret if the file exists
// and is readable. If absent, returns nil so the CLI keeps working against
// daemons built without W3 HMAC enforcement (unlikely now, but allows graceful
// rollout). A daemon with HMAC enabled will reject the connection if the key
// is missing/wrong, surfacing a clear error to the user.
func loadHMACKeyOrNil() []byte {
	key, err := ipc.LoadOrCreateHMACKey(ipc.DefaultHMACKeyPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "warn: could not load IPC key: %v\n", err)
		return nil
	}
	return key
}
