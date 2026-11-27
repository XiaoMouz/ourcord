//go:build !voice

package main

import (
	"context"
	"strconv"
	"testing"

	"github.com/ourcord/ourcord/daemon/pkg/ipc"
	"github.com/ourcord/ourcord/daemon/pkg/routing"
	"github.com/ourcord/ourcord/daemon/pkg/wg"
)

// The default build uses silent audio: exercise the same IPC commands as the
// desktop without opening a microphone or requiring a VPN adapter.
func TestChangingAudioDevicesPreservesPrivacyState(t *testing.T) {
	for _, tc := range []struct {
		name            string
		muted, deafened bool
	}{
		{"muted", true, false},
		{"deafened", false, true},
		{"both", true, true},
		{"neither", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key, err := wg.GenerateKeyPair()
			if err != nil {
				t.Fatal(err)
			}
			d := &daemon{
				keyPair: key, table: routing.NewTable(),
				assignedIP4: "127.0.0.1", activeRoom: "device-change-test",
			}
			d.vpnActive.Store(true)
			t.Cleanup(d.voiceLeave)
			call := func(cmd string, params map[string]string) ipc.IPCResponse {
				t.Helper()
				response := d.HandleIPC(context.Background(), ipc.IPCRequest{Cmd: cmd, Params: params})
				if !response.OK {
					t.Fatalf("%s: %s", cmd, response.Error)
				}
				return response
			}
			call(ipc.CmdVoiceJoin, nil)
			call(ipc.CmdVoiceMute, map[string]string{"on": strconv.FormatBool(tc.muted)})
			call(ipc.CmdVoiceDeafen, map[string]string{"on": strconv.FormatBool(tc.deafened)})
			for _, device := range []string{"headset", "speakers"} {
				call(ipc.CmdVoiceSetDevices, map[string]string{"capture_id": device + "-mic", "playback_id": device})
				status := call(ipc.CmdVoiceStatus, nil).Data.(ipc.VoiceStatus)
				if !status.Joined || status.Muted != tc.muted || status.Deafened != tc.deafened {
					t.Fatalf("changing to %s changed privacy state: %+v; want muted=%v deafened=%v", device, status, tc.muted, tc.deafened)
				}
			}
		})
	}
}
