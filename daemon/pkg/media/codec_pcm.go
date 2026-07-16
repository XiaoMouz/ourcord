package media

import (
	"encoding/binary"
	"fmt"
)

// PCMCodec is a lossless little-endian s16 passthrough. It is the pure-Go
// default codec: it lets the whole pipeline (crypto, RTP, jitter, mixing, the
// daemon/CLI wiring, and the netns E2E) run and be verified with no cgo, and it
// is exact so tests can assert bit-for-bit audio. It is NOT bandwidth-efficient
// (768 kbps/mono), so real deployments build with the `voice` tag for Opus.
type PCMCodec struct{}

// NewPCMCodec returns a stateless PCM passthrough codec.
func NewPCMCodec() *PCMCodec { return &PCMCodec{} }

// Name reports the wire codec identifier.
func (*PCMCodec) Name() string { return "pcm" }

// Encode serializes exactly FrameSamples s16 samples as little-endian bytes.
func (*PCMCodec) Encode(pcm []int16) ([]byte, error) {
	if len(pcm) != FrameSamples {
		return nil, fmt.Errorf("pcm encode: got %d samples, want %d", len(pcm), FrameSamples)
	}
	out := make([]byte, len(pcm)*2)
	for i, s := range pcm {
		binary.LittleEndian.PutUint16(out[i*2:], uint16(s))
	}
	return out, nil
}

// Decode parses a FrameSamples-length s16le payload.
func (*PCMCodec) Decode(payload []byte) ([]int16, error) {
	if len(payload) != FrameSamples*2 {
		return nil, fmt.Errorf("pcm decode: got %d bytes, want %d", len(payload), FrameSamples*2)
	}
	out := make([]int16, len(payload)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(payload[i*2:]))
	}
	return out, nil
}
