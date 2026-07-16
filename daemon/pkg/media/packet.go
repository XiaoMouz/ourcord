package media

import (
	"encoding/binary"
	"errors"

	"github.com/pion/rtp"
)

// Wire format for one voice datagram:
//
//	[ RTP header | 8-byte AEAD counter (big-endian) | ChaCha20-Poly1305(payload) ]
//
// The RTP header (pion/rtp) carries sequence/timestamp/SSRC and is authenticated
// as AEAD additional data. The explicit counter makes decryption independent of
// RTP field widths (the 16-bit RTP sequence wraps; the AEAD counter does not).
const (
	voicePayloadType = 111 // dynamic PT, matches WebRTC Opus convention
	counterFieldLen  = 8
)

var errShortPacket = errors.New("media: packet too short")

// marshalPacket builds the datagram: RTP header (seq/ts/ssrc), then the
// counter, then the sealed payload. aad returned is the marshalled RTP header
// so the caller seals with the exact bytes that go on the wire.
func marshalHeader(seq uint16, timestamp, ssrc uint32) (*rtp.Header, []byte, error) {
	h := &rtp.Header{
		Version:        2,
		PayloadType:    voicePayloadType,
		SequenceNumber: seq,
		Timestamp:      timestamp,
		SSRC:           ssrc,
	}
	aad, err := h.Marshal()
	if err != nil {
		return nil, nil, err
	}
	return h, aad, nil
}

// assemble concatenates the RTP header bytes, the counter, and the ciphertext.
func assemble(header, ciphertext []byte, counter uint64) []byte {
	out := make([]byte, len(header)+counterFieldLen+len(ciphertext))
	n := copy(out, header)
	binary.BigEndian.PutUint64(out[n:], counter)
	copy(out[n+counterFieldLen:], ciphertext)
	return out
}

// parsedPacket is the decoded framing of an incoming datagram (before AEAD
// open): the RTP header, the header bytes to authenticate as AAD, the sender's
// counter, and the still-sealed payload.
type parsedPacket struct {
	header     rtp.Header
	aad        []byte
	counter    uint64
	ciphertext []byte
}

// parsePacket splits a datagram into RTP header / counter / ciphertext.
func parsePacket(datagram []byte) (*parsedPacket, error) {
	var h rtp.Header
	n, err := h.Unmarshal(datagram)
	if err != nil {
		return nil, err
	}
	if len(datagram) < n+counterFieldLen {
		return nil, errShortPacket
	}
	counter := binary.BigEndian.Uint64(datagram[n : n+counterFieldLen])
	return &parsedPacket{
		header:     h,
		aad:        datagram[:n],
		counter:    counter,
		ciphertext: datagram[n+counterFieldLen:],
	}, nil
}
