//go:build voice

package media

import (
	"fmt"

	"github.com/hraban/opus"
)

// Real Opus codec, compiled only with the `voice` build tag (cgo → libopus).
// An init() rebinds newDefaultCodec so the engine, daemon, CLI, and tests all
// use Opus with no other change; the default (tag-less) build stays CGO=0 and
// cross-compilable. Each peer gets its own decoder (NewDecoder), which is why
// Codec is a factory — libopus decoder state is per-stream.
//
// Bandwidth: ~32 kbps VBR, VoIP-tuned, versus PCM's 768 kbps — this is what
// makes voice usable on real networks.

const opusBitrate = 32000

func init() {
	newDefaultCodec = func() (Codec, error) { return opusCodec{}, nil }
}

type opusCodec struct{}

func (opusCodec) Name() string { return "opus" }

func (opusCodec) NewEncoder() (Encoder, error) {
	enc, err := opus.NewEncoder(SampleRate, Channels, opus.AppVoIP)
	if err != nil {
		return nil, fmt.Errorf("opus encoder: %w", err)
	}
	if err := enc.SetBitrate(opusBitrate); err != nil {
		return nil, fmt.Errorf("opus bitrate: %w", err)
	}
	return &opusEncoder{enc: enc, buf: make([]byte, 4000)}, nil
}

func (opusCodec) NewDecoder() (Decoder, error) {
	dec, err := opus.NewDecoder(SampleRate, Channels)
	if err != nil {
		return nil, fmt.Errorf("opus decoder: %w", err)
	}
	return &opusDecoder{dec: dec}, nil
}

type opusEncoder struct {
	enc *opus.Encoder
	buf []byte // scratch; one encoder is used by the single send goroutine
}

func (e *opusEncoder) Encode(pcm []int16) ([]byte, error) {
	if len(pcm) != FrameSamples {
		return nil, fmt.Errorf("opus encode: got %d samples, want %d", len(pcm), FrameSamples)
	}
	n, err := e.enc.Encode(pcm, e.buf)
	if err != nil {
		return nil, err
	}
	out := make([]byte, n)
	copy(out, e.buf[:n])
	return out, nil
}

type opusDecoder struct {
	dec *opus.Decoder
}

func (d *opusDecoder) Decode(payload []byte) ([]int16, error) {
	pcm := make([]int16, FrameSamples)
	n, err := d.dec.Decode(payload, pcm)
	if err != nil {
		return nil, err
	}
	return pcm[:n], nil
}
