// Package media implements OurCord's Phase-3 voice engine: capture → encode →
// per-peer end-to-end encrypt → RTP → UDP over the VPN overlay, and the reverse
// on receive with a jitter buffer and mixing. It is transport-agnostic about
// the mesh: voice is plain UDP to each peer's VPN IP, so A-B-C relay (kernel
// forwarding) is transparent and media stays E2E-encrypted through the hop.
//
// The audio codec is abstracted behind Codec. The default (pure-Go, CGO=0,
// cross-compilable) build uses the PCM codec; a build with the `voice` tag
// swaps in a real Opus codec (cgo → libopus) alongside the hardware audio
// devices. When a pure-Go Opus encoder is available upstream it becomes the
// default codec — a one-file swap.
package media

const (
	// SampleRate is the fixed voice sample rate (Opus's native rate).
	SampleRate = 48000
	// Channels is mono for v1.
	Channels = 1
	// FrameMillis is the packetization interval.
	FrameMillis = 20
	// FrameSamples is the per-frame PCM sample count (960 for 48kHz/20ms mono).
	FrameSamples = SampleRate / 1000 * FrameMillis * Channels
)

// Codec is a factory for a stateful audio codec. Encode and decode state are
// separated because they have different lifetimes: one Encoder per engine (the
// single local capture stream) and one Decoder per remote peer (each is an
// independent Opus stream — sharing a decoder across peers corrupts inter-frame
// state).
type Codec interface {
	// Name identifies the codec on the wire/status ("pcm", "opus").
	Name() string
	// NewEncoder returns an encoder for the local outbound stream.
	NewEncoder() (Encoder, error)
	// NewDecoder returns a decoder for one inbound peer stream.
	NewDecoder() (Decoder, error)
}

// Encoder encodes one 20 ms mono 48 kHz frame (exactly FrameSamples s16).
type Encoder interface {
	Encode(pcm []int16) ([]byte, error)
}

// Decoder decodes one frame from a single peer's stream.
type Decoder interface {
	Decode(payload []byte) ([]int16, error)
}

// newDefaultCodec returns the codec for the current build. The voice-tagged
// build rebinds this (init) to return the Opus codec. Single construction point.
var newDefaultCodec = func() (Codec, error) { return NewPCMCodec(), nil }
