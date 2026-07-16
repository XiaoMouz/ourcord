//go:build voice

package media

import "testing"

// With the voice tag the audio backend is present, so enumeration is supported
// (the device lists may be empty on a headless CI runner — that is still
// "supported", just no hardware).
func TestAudioDevicesSupportedWithVoiceTag(t *testing.T) {
	_, _, supported := AudioDevices()
	if !supported {
		t.Fatal("voice build must report the audio backend as supported")
	}
}
