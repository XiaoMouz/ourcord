// Package media implements OurCord's Phase-3 voice engine: capture → encode →
// per-peer end-to-end encrypt → RTP → UDP over the VPN overlay, and the reverse
// on receive with a jitter buffer and mixing. It is transport-agnostic about
// the mesh: voice is plain UDP to each peer's VPN IP, so A-B-C relay (kernel
// forwarding) is transparent and media stays E2E-encrypted through the hop.
//
// The audio codec is abstracted behind Codec. The default (pure-Go, CGO=0,
// cross-compilable) build uses PCMCodec; a build with the `voice` tag swaps in
// a real Opus codec alongside the hardware audio devices. When a pure-Go Opus
// encoder is available upstream it becomes the default codec — a one-file swap.
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

// Codec encodes/decodes one 20 ms mono 48 kHz frame. Encode takes exactly
// FrameSamples s16 samples; Decode returns exactly FrameSamples samples (a
// codec may pad/conceal internally). Implementations must be safe for use by a
// single sender goroutine (Encode) and per-peer receiver goroutines (Decode)
// concurrently — i.e. Encode and Decode must not share mutable state, or must
// lock it.
type Codec interface {
	// Name identifies the codec on the wire/status ("pcm", "opus").
	Name() string
	Encode(pcm []int16) ([]byte, error)
	Decode(payload []byte) ([]int16, error)
}

// newDefaultCodec returns the codec for the current build. Overridden by the
// voice-tagged build to return the Opus codec. Kept as a var so the engine has
// a single construction point.
var newDefaultCodec = func() (Codec, error) { return NewPCMCodec(), nil }
