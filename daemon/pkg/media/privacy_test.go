package media

import (
	"net/netip"
	"testing"
)

func privacyFrame(value int16) []int16 {
	frame := make([]int16, FrameSamples)
	for i := range frame {
		frame[i] = value
	}
	return frame
}

func TestClosedPrivacyGateDoesNotReplayCapturedAudio(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode InputMode
		mute bool
	}{
		{"muted-open-mic", InputModeOpenMic, true},
		{"muted-voice-activity", InputModeVoiceActivity, true},
		{"muted-push-to-talk", InputModePushToTalk, true},
		{"released-push-to-talk", InputModePushToTalk, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fab := newFabric()
			senderAddr, receiverAddr := netip.MustParseAddr("198.19.0.10"), netip.MustParseAddr("198.19.0.11")
			receiver := fab.endpoint(receiverAddr)
			key := mustKey(t)
			e, err := Start(Config{
				SelfKey: key, Counters: testCounters(key), VPN4: senderAddr, Conn: fab.endpoint(senderAddr),
				CaptureSource: idleCapture(), InputMode: tc.mode,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Stop()
			e.UpdatePeers([]PeerInfo{{PublicKey: mustKey(t).PublicKey(), VPN4: receiverAddr}})
			process := func(frame []int16) {
				// Drive the real capture -> encode/encrypt -> datagram path
				// deterministically, without hardware or timing-dependent sleeps.
				for _, ready := range e.captureFrames(frame) {
					e.broadcast(ready)
				}
			}
			for cycle := 0; cycle < 2; cycle++ {
				if tc.mute {
					e.SetPushToTalk(true)
					e.SetMute(true)
				} else {
					e.SetPushToTalk(false)
				}
				for i := 0; i < 20; i++ {
					process(privacyFrame(2000))
				}
				if len(receiver.in) != 0 {
					t.Fatal("closed privacy gate transmitted audio")
				}
				if tc.mute {
					e.SetMute(false)
				} else {
					e.SetPushToTalk(true)
				}
				fresh := privacyFrame(8000)
				frames := e.captureFrames(fresh)
				for _, frame := range frames {
					e.broadcast(frame)
				}
				if len(receiver.in) != 1 {
					t.Fatalf("opening gate sent %d encrypted datagrams for one new frame (cycle %d)", len(receiver.in), cycle)
				}
				if len(frames) != 1 || frames[0][0] != fresh[0] {
					t.Fatal("opening gate included audio captured while closed")
				}
				<-receiver.in
			}
		})
	}
}

func TestMuteDiscardsAlreadyBufferedPreRoll(t *testing.T) {
	e := &Engine{inputMode: InputModeVoiceActivity, vadThreshold: -45}
	for i := 0; i < preRollFrames; i++ {
		e.captureFrames(privacyFrame(0))
	}
	e.SetMute(true)
	e.SetMute(false)
	frames := e.captureFrames(privacyFrame(8000))
	if len(frames) != 1 || frames[0][0] != 8000 {
		t.Fatalf("unmute retained audio from before the mute boundary: %d frames", len(frames))
	}
}
