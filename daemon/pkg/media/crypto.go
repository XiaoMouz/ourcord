package media

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"
	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// Media is end-to-end encrypted per peer pair. A-B-C relay forwards inner
// packets in the clear at the WireGuard layer, so a relay hop that is not a
// call participant would otherwise see the audio. We derive a pairwise key with
// no extra signaling by reusing the WireGuard static keys both ends already
// hold:
//
//	shared = X25519(ourWgPriv, peerWgPub)          // == X25519(peerPriv, ourPub)
//	key    = HKDF-SHA256(shared, salt, info)        // 32-byte ChaCha20 key
//	  salt = "ourcord-voice-v1"
//	  info = lexically-sorted(ourPub32 || peerPub32) // symmetric on both ends
//
// v1 has no forward secrecy (a compromised WG private key retro-decrypts
// captured audio); an ephemeral rekey inside this channel is a documented
// follow-up. The RTP header travels as AEAD additional data (authenticated but
// not encrypted, so routing/jitter can read seq/ts/ssrc); the payload is
// sealed. The nonce is the 4-byte SSRC followed by an 8-byte monotonic send
// counter, unique per (sender, key).
const (
	voiceHKDFSalt = "ourcord-voice-v1"
	nonceSize     = chacha20poly1305.NonceSize // 12
)

var errReplay = errors.New("media: replayed or too-old counter")

// pairKey derives the ChaCha20-Poly1305 key shared with a peer. ourPriv is this
// daemon's WireGuard private key; peerPub is the peer's WireGuard public key.
func pairKey(ourPriv, peerPub wgtypes.Key) ([]byte, error) {
	shared, err := curve25519.X25519(ourPriv[:], peerPub[:])
	if err != nil {
		return nil, fmt.Errorf("media: x25519: %w", err)
	}
	ourPub := publicKeyOf(ourPriv)
	info := sortedPubPair(ourPub, peerPub)
	r := hkdf.New(sha256.New, shared, []byte(voiceHKDFSalt), info)
	key := make([]byte, chacha20poly1305.KeySize)
	if _, err := io.ReadFull(r, key); err != nil {
		return nil, fmt.Errorf("media: hkdf: %w", err)
	}
	return key, nil
}

func publicKeyOf(priv wgtypes.Key) wgtypes.Key { return priv.PublicKey() }

// sortedPubPair returns the two 32-byte keys concatenated in lexical order so
// both ends derive the same info regardless of who initiates.
func sortedPubPair(a, b wgtypes.Key) []byte {
	out := make([]byte, 64)
	if bytesLess(a[:], b[:]) {
		copy(out, a[:])
		copy(out[32:], b[:])
	} else {
		copy(out, b[:])
		copy(out[32:], a[:])
	}
	return out
}

func bytesLess(a, b []byte) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// sealer encrypts outgoing frames toward one peer using a reserved counter.
type sealer struct {
	aead interface {
		Seal([]byte, []byte, []byte, []byte) []byte
	}
	ssrc uint32
}

func newSealer(key []byte, ssrc uint32) (*sealer, error) {
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, err
	}
	return &sealer{aead: aead, ssrc: ssrc}, nil
}

// seal encrypts payload, authenticating aad (the RTP header). The caller must
// supply a unique reserved counter, including its peer-direction prefix.
func (s *sealer) seal(payload, aad []byte, counter uint64) []byte {
	nonce := make([]byte, nonceSize)
	binary.BigEndian.PutUint32(nonce, s.ssrc)
	binary.BigEndian.PutUint64(nonce[4:], counter)
	return s.aead.Seal(nil, nonce, payload, aad)
}

// opener decrypts incoming frames from one peer, rejecting replays with a
// sliding window over the sender's counter.
type opener struct {
	aead interface {
		Open([]byte, []byte, []byte, []byte) ([]byte, error)
	}
	ssrc   uint32
	window *replayWindow
}

func newOpener(key []byte, ssrc uint32) (*opener, error) {
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, err
	}
	return &opener{aead: aead, ssrc: ssrc, window: newReplayWindow()}, nil
}

// open authenticates aad and decrypts ciphertext for the given counter, then
// records the counter as seen. A duplicate/too-old counter or a failed tag
// returns an error and does not advance state.
func (o *opener) open(ciphertext, aad []byte, counter uint64) ([]byte, error) {
	if !o.window.ok(counter) {
		return nil, errReplay
	}
	nonce := make([]byte, nonceSize)
	binary.BigEndian.PutUint32(nonce, o.ssrc)
	binary.BigEndian.PutUint64(nonce[4:], counter)
	plain, err := o.aead.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return nil, err
	}
	o.window.mark(counter)
	return plain, nil
}

// ssrcFor derives a stable 32-bit SSRC from a WireGuard public key (first 4
// bytes of its SHA-256). Collisions across a small room are negligible and only
// affect display, not crypto (the key is pairwise).
func ssrcFor(pub wgtypes.Key) uint32 {
	h := sha256.Sum256(pub[:])
	return binary.BigEndian.Uint32(h[:4])
}

// replayWindow is a 64-entry sliding window (RFC 3711 style) over a monotonic
// counter.
type replayWindow struct {
	highest uint64
	bitmap  uint64
	seenAny bool
}

func newReplayWindow() *replayWindow { return &replayWindow{} }

const replayWindowSize = 64

// ok reports whether counter is acceptable (new, within the window) without
// mutating state.
func (w *replayWindow) ok(counter uint64) bool {
	if !w.seenAny {
		return true
	}
	if counter > w.highest {
		return true
	}
	diff := w.highest - counter
	if diff >= replayWindowSize {
		return false // too old
	}
	return w.bitmap&(1<<diff) == 0
}

// mark records counter as seen; call only after a successful open.
func (w *replayWindow) mark(counter uint64) {
	if !w.seenAny {
		w.seenAny, w.highest, w.bitmap = true, counter, 1
		return
	}
	if counter > w.highest {
		shift := counter - w.highest
		if shift >= replayWindowSize {
			w.bitmap = 1
		} else {
			w.bitmap = (w.bitmap << shift) | 1
		}
		w.highest = counter
		return
	}
	if diff := w.highest - counter; diff < replayWindowSize {
		w.bitmap |= 1 << diff
	}
}
