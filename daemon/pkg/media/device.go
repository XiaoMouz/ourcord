package media

import "time"

// Device abstracts the local audio hardware so the engine is testable without a
// sound card and cross-compilable without cgo. The default build uses
// nullDevice (silent capture with an injectable tone seam, discarded playback);
// the `voice`-tagged build provides a malgo/miniaudio device with real
// capture/playback and enumeration.
//
// Capture returns a channel of 20 ms mono s16 frames (FrameSamples each) and
// runs until Close. Playback is called once per peer-mix per tick with a frame
// to render.
type Device interface {
	Capture() <-chan []int16
	Playback(frame []int16)
	Close() error
}

// AudioDeviceInfo describes a selectable capture/playback device (voice build).
type AudioDeviceInfo struct {
	ID        string
	Name      string
	IsDefault bool
}

// newDevice constructs the audio device for the current build. Overridden by
// the voice-tagged build. captureSource, when non-nil, replaces live capture
// with a test frame source (used by the null device and integration tests).
var newDevice = func(captureSource <-chan []int16) (Device, error) {
	return newNullDevice(captureSource), nil
}

// listAudioDevices enumerates hardware devices. The default build has none;
// the voice-tagged build overrides this.
var listAudioDevices = func() (capture, playback []AudioDeviceInfo, supported bool) {
	return nil, nil, false
}

// nullDevice is the headless default: capture yields whatever is fed to it (a
// silent generator by default, or a caller-supplied source for tests), and
// playback is discarded. It lets the full pipeline run in CI and the netns E2E.
type nullDevice struct {
	src  <-chan []int16
	done chan struct{}
}

func newNullDevice(captureSource <-chan []int16) *nullDevice {
	d := &nullDevice{src: captureSource, done: make(chan struct{})}
	if d.src == nil {
		// Silent capture paced at the real frame cadence (20 ms), mimicking
		// hardware: a mic delivers 50 frames/s, so the engine paces to that. An
		// unpaced source would busy-loop the send path.
		ch := make(chan []int16)
		go func() {
			t := time.NewTicker(FrameMillis * time.Millisecond)
			defer t.Stop()
			for {
				select {
				case <-d.done:
					return
				case <-t.C:
					select {
					case ch <- silence():
					case <-d.done:
						return
					}
				}
			}
		}()
		d.src = ch
	}
	return d
}

func (d *nullDevice) Capture() <-chan []int16 { return d.src }
func (d *nullDevice) Playback([]int16)        {}
func (d *nullDevice) Close() error {
	select {
	case <-d.done:
	default:
		close(d.done)
	}
	return nil
}
