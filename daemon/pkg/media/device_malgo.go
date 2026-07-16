//go:build voice

package media

import (
	"encoding/binary"
	"fmt"
	"sync"

	"github.com/gen2brain/malgo"
)

// Real audio device backed by malgo/miniaudio, compiled only with the `voice`
// tag (cgo). init() rebinds newDevice and listAudioDevices so the daemon uses
// the microphone/speaker; the default build keeps the null device and reports
// audio devices unsupported.
//
// Capture runs a malgo capture device whose data callback packetizes the mic
// stream into FrameSamples frames onto the engine's capture channel. Playback
// runs a malgo playback device fed from a ring of frames. A test capture source
// still short-circuits to the null device so integration tests don't need
// hardware even under the voice tag.

func init() {
	newDevice = func(captureSource <-chan []int16, sel AudioSelection) (Device, error) {
		if captureSource != nil {
			return newNullDevice(captureSource), nil // test seam
		}
		return newMalgoDevice(sel)
	}
	listAudioDevices = malgoListDevices
}

// resolveDeviceID enumerates devices of kind and returns an owned copy of the
// malgo DeviceID whose String() matches id, or nil (⇒ system default) when id
// is empty or not found. Returning a copy (not a pointer into the enumerated
// slice) keeps the ID alive independently of the slice for InitDevice.
func resolveDeviceID(ctx malgo.Context, kind malgo.DeviceType, id string) *malgo.DeviceID {
	if id == "" {
		return nil
	}
	infos, err := ctx.Devices(kind)
	if err != nil {
		return nil
	}
	for i := range infos {
		if infos[i].ID.String() == id {
			cp := infos[i].ID
			return &cp
		}
	}
	return nil // unknown id → fall back to default
}

func malgoListDevices() (capture, playback []AudioDeviceInfo, supported bool) {
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, nil, false
	}
	defer func() { _ = ctx.Uninit(); ctx.Free() }()
	conv := func(kind malgo.DeviceType) []AudioDeviceInfo {
		infos, err := ctx.Devices(kind)
		if err != nil {
			return nil
		}
		out := make([]AudioDeviceInfo, 0, len(infos))
		for i := range infos {
			out = append(out, AudioDeviceInfo{
				ID:        infos[i].ID.String(),
				Name:      infos[i].Name(),
				IsDefault: infos[i].IsDefault != 0,
			})
		}
		return out
	}
	return conv(malgo.Capture), conv(malgo.Playback), true
}

type malgoDevice struct {
	ctx      *malgo.AllocatedContext
	capture  *malgo.Device
	playback *malgo.Device
	out      chan []int16

	mu      sync.Mutex
	pending []int16 // capture accumulator until a full frame is ready
	playbuf []int16 // playback queue
	closed  bool
}

func newMalgoDevice(sel AudioSelection) (Device, error) {
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, fmt.Errorf("malgo context: %w", err)
	}
	d := &malgoDevice{ctx: ctx, out: make(chan []int16, 8)}

	// Resolve selected device IDs (kept alive until InitDevice copies them).
	capID := resolveDeviceID(ctx.Context, malgo.Capture, sel.CaptureID)
	playID := resolveDeviceID(ctx.Context, malgo.Playback, sel.PlaybackID)

	capCfg := malgo.DefaultDeviceConfig(malgo.Capture)
	capCfg.Capture.Format = malgo.FormatS16
	capCfg.Capture.Channels = Channels
	capCfg.SampleRate = SampleRate
	if capID != nil {
		capCfg.Capture.DeviceID = capID.Pointer()
	}
	cap, err := malgo.InitDevice(ctx.Context, capCfg, malgo.DeviceCallbacks{Data: d.onCapture})
	if err != nil {
		ctx.Uninit()
		ctx.Free()
		return nil, fmt.Errorf("malgo capture: %w", err)
	}
	playCfg := malgo.DefaultDeviceConfig(malgo.Playback)
	playCfg.Playback.Format = malgo.FormatS16
	playCfg.Playback.Channels = Channels
	playCfg.SampleRate = SampleRate
	if playID != nil {
		playCfg.Playback.DeviceID = playID.Pointer()
	}
	play, err := malgo.InitDevice(ctx.Context, playCfg, malgo.DeviceCallbacks{Data: d.onPlayback})
	if err != nil {
		cap.Uninit()
		ctx.Uninit()
		ctx.Free()
		return nil, fmt.Errorf("malgo playback: %w", err)
	}
	d.capture, d.playback = cap, play
	if err := cap.Start(); err != nil {
		play.Uninit()
		cap.Uninit()
		ctx.Uninit()
		ctx.Free()
		return nil, fmt.Errorf("malgo capture start: %w", err)
	}
	if err := play.Start(); err != nil {
		cap.Stop()
		play.Uninit()
		cap.Uninit()
		ctx.Uninit()
		ctx.Free()
		return nil, fmt.Errorf("malgo playback start: %w", err)
	}
	return d, nil
}

// onCapture accumulates mic samples and emits complete FrameSamples frames.
func (d *malgoDevice) onCapture(_, in []byte, frameCount uint32) {
	n := int(frameCount) * Channels
	if n*2 > len(in) {
		n = len(in) / 2
	}
	d.mu.Lock()
	for i := 0; i < n; i++ {
		d.pending = append(d.pending, int16(binary.LittleEndian.Uint16(in[i*2:])))
	}
	var frames [][]int16
	for len(d.pending) >= FrameSamples {
		f := make([]int16, FrameSamples)
		copy(f, d.pending[:FrameSamples])
		d.pending = d.pending[FrameSamples:]
		frames = append(frames, f)
	}
	closed := d.closed
	d.mu.Unlock()
	for _, f := range frames {
		if closed {
			return
		}
		select {
		case d.out <- f:
		default: // capture faster than the engine consumes → drop
		}
	}
}

// onPlayback fills the speaker buffer from the playback queue, zero-padding.
func (d *malgoDevice) onPlayback(out, _ []byte, frameCount uint32) {
	want := int(frameCount) * Channels
	d.mu.Lock()
	for i := 0; i < want; i++ {
		var s int16
		if len(d.playbuf) > 0 {
			s = d.playbuf[0]
			d.playbuf = d.playbuf[1:]
		}
		if i*2+1 < len(out) {
			binary.LittleEndian.PutUint16(out[i*2:], uint16(s))
		}
	}
	d.mu.Unlock()
}

func (d *malgoDevice) Capture() <-chan []int16 { return d.out }

func (d *malgoDevice) Playback(frame []int16) {
	d.mu.Lock()
	// Bound the queue so a stalled speaker can't grow memory unbounded.
	if len(d.playbuf) < FrameSamples*10 {
		d.playbuf = append(d.playbuf, frame...)
	}
	d.mu.Unlock()
}

func (d *malgoDevice) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
	d.mu.Unlock()
	if d.capture != nil {
		_ = d.capture.Stop()
		d.capture.Uninit()
	}
	if d.playback != nil {
		_ = d.playback.Stop()
		d.playback.Uninit()
	}
	_ = d.ctx.Uninit()
	d.ctx.Free()
	return nil
}
