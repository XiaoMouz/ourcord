//go:build !voice

package media

import "testing"

// The default (non-voice) build has no audio backend, so device enumeration
// reports unsupported. The voice-tagged build asserts the opposite.
func TestAudioDevicesUnsupportedInDefaultBuild(t *testing.T) {
	capture, playback, supported := AudioDevices()
	if supported || capture != nil || playback != nil {
		t.Fatalf("default build must report no audio backend, got supported=%v", supported)
	}
}
