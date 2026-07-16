package media

// jitterBuffer is a minimal fixed-depth reordering buffer for one peer's frames.
// Real-time voice trades latency for smoothness: we hold `depth` frames so a
// late/reordered packet still has a slot, and on a gap we emit a concealment
// (silence) frame rather than stalling. v1 depth is fixed (adaptive depth is a
// documented follow-up).
//
// Frames are keyed by RTP sequence number (16-bit, wrapping). pop() advances a
// read cursor one frame per call (i.e. once per 20 ms tick), so playback runs
// at a steady rate independent of arrival jitter.
type jitterBuffer struct {
	depth   int
	frames  map[uint16][]int16
	nextSeq uint16
	primed  bool

	received uint64 // frames accepted into the buffer
	lost     uint64 // concealment frames emitted for missing sequences
}

func newJitterBuffer(depth int) *jitterBuffer {
	return &jitterBuffer{depth: depth, frames: make(map[uint16][]int16)}
}

// push inserts a decoded frame at its sequence number. Frames far behind the
// read cursor (already played past) are dropped as too-late.
func (j *jitterBuffer) push(seq uint16, pcm []int16) {
	if j.primed && seqLess(seq, j.nextSeq) {
		return // already played past this sequence
	}
	j.frames[seq] = pcm
}

// pop returns the next frame to play and whether it was real audio (false ⇒
// concealment/silence for a missing frame). It waits until at least `depth`
// frames are buffered before starting, then advances one sequence per call.
func (j *jitterBuffer) pop() (pcm []int16, real bool) {
	if !j.primed {
		if len(j.frames) < j.depth {
			return nil, false // still filling
		}
		j.nextSeq = j.lowestSeq()
		j.primed = true
	}
	seq := j.nextSeq
	j.nextSeq++
	if f, ok := j.frames[seq]; ok {
		delete(j.frames, seq)
		j.received++
		return f, true
	}
	j.lost++
	return silence(), false
}

func (j *jitterBuffer) lowestSeq() uint16 {
	first := true
	var low uint16
	for seq := range j.frames {
		if first || seqLess(seq, low) {
			low, first = seq, false
		}
	}
	return low
}

// lossPercent is emitted-concealment / (received+concealed).
func (j *jitterBuffer) lossPercent() float64 {
	total := j.received + j.lost
	if total == 0 {
		return 0
	}
	return float64(j.lost) / float64(total) * 100
}

// seqLess reports a < b in 16-bit sequence space (RFC 1982 serial arithmetic).
func seqLess(a, b uint16) bool {
	return a != b && uint16(b-a) < 0x8000
}

func silence() []int16 { return make([]int16, FrameSamples) }
