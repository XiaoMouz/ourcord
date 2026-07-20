package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/ourcord/ourcord/daemon/pkg/client"
)

// runVoice dispatches the voice subcommands over the shared client core.
// Usage: ourcord-cli voice <join|leave|mute|unmute|deafen|undeafen|status|devices|set-device|input-mode>
func runVoice(socketPath string, args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: ourcord-cli voice <join|leave|mute|unmute|deafen|undeafen|status|devices|set-device|input-mode>")
		return 1
	}
	cli, err := client.Dial(socketPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: could not connect to daemon (%s): %v\nIs ourcordd running?\n", socketPath, err)
		return 1
	}
	defer cli.Close()

	switch args[0] {
	case "join":
		// voice join [--network <id>] — with --network, run the core
		// JoinVoiceNetwork orchestration (leave voice / switch network /
		// connect / enter) instead of only joining the current network's voice.
		fs := flag.NewFlagSet("voice join", flag.ContinueOnError)
		network := fs.String("network", "", "room vpn_namespace to switch to before joining voice")
		if err := fs.Parse(args[1:]); err != nil {
			return 1
		}
		if *network != "" {
			return emitOK(cli.JoinVoiceNetwork(*network, nil))
		}
		return emitOK(cli.VoiceJoin())
	case "leave":
		return emitOK(cli.VoiceLeave())
	case "mute":
		return emitOK(cli.SetVoiceMute(true))
	case "unmute":
		return emitOK(cli.SetVoiceMute(false))
	case "deafen":
		return emitOK(cli.SetVoiceDeafen(true))
	case "undeafen":
		return emitOK(cli.SetVoiceDeafen(false))
	case "status":
		st, err := cli.VoiceStatus()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		out, _ := json.MarshalIndent(st, "", "  ")
		fmt.Println(string(out))
		return 0
	case "devices":
		capture, playback, err := cli.ListAudioDevices()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return 1
		}
		out, _ := json.MarshalIndent(map[string]any{"capture": capture, "playback": playback}, "", "  ")
		fmt.Println(string(out))
		return 0
	case "set-device":
		// voice set-device [capture_id] [playback_id] — empty = system default.
		var captureID, playbackID string
		if len(args) >= 2 {
			captureID = args[1]
		}
		if len(args) >= 3 {
			playbackID = args[2]
		}
		return emitOK(cli.SetAudioDevices(captureID, playbackID))
	case "input-mode":
		if len(args) != 2 {
			fmt.Fprintln(os.Stderr, "Usage: ourcord-cli voice input-mode <voice_activity|push_to_talk|open_mic>")
			return 1
		}
		return emitOK(cli.SetVoiceInputMode(args[1], -45, 300))
	default:
		fmt.Fprintf(os.Stderr, "Unknown voice command: %s\n", args[0])
		return 1
	}
}
