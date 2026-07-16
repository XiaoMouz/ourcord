package media

import (
	"context"
	"net/netip"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/wgctrl/wgtypes"
)

// speakingWindow is how recently a peer's packet must have arrived to count as
// "speaking" (and, for the sender, how we bound liveness display).
const speakingWindow = 500 * time.Millisecond

// PeerInfo is a voice participant: their WireGuard public key and current VPN
// IPv4. The engine keeps voice membership in sync with the mesh via UpdatePeers.
type PeerInfo struct {
	PublicKey wgtypes.Key
	VPN4      netip.Addr
}

// Config starts an engine. Conn and Dev are injectable seams (tests supply a
// pipe conn and a tone source); production passes nil to bind real UDP + the
// build's Device.
type Config struct {
	SelfKey   wgtypes.Key // this daemon's WireGuard private key
	VPN4      netip.Addr  // this daemon's VPN IPv4 (voice binds here)
	NetworkID string

	Conn          packetConn     // nil ⇒ bind VoicePort on VPN4
	CaptureSource <-chan []int16 // nil ⇒ build default device's capture
}

// Engine is one voice session. It captures locally, encodes+encrypts once per
// tick and fans out to every peer, and on receive decrypts+decodes+jitter-
// buffers per peer and mixes for playback. All exported methods are safe for
// concurrent use.
type Engine struct {
	cfg    Config
	codec  Codec
	dev    Device
	conn   packetConn
	ssrc   uint32
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu       sync.Mutex
	peers    map[wgtypes.Key]*peerState
	byAddr   map[netip.Addr]*peerState
	muted    bool
	deafened bool
	seq      uint16
	ts       uint32
}

type peerState struct {
	info   PeerInfo
	sealer *sealer
	opener *opener
	jitter *jitterBuffer

	txPackets uint64
	rxPackets uint64
	lastRx    time.Time
	secure    bool
}

// Start builds the codec/device/socket and launches the send and receive loops.
func Start(cfg Config) (*Engine, error) {
	codec, err := newDefaultCodec()
	if err != nil {
		return nil, err
	}
	conn := cfg.Conn
	if conn == nil {
		udp, err := bindVoiceUDP(cfg.VPN4)
		if err != nil {
			return nil, err
		}
		conn = udp
	}
	dev, err := newDevice(cfg.CaptureSource)
	if err != nil {
		conn.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := &Engine{
		cfg:    cfg,
		codec:  codec,
		dev:    dev,
		conn:   conn,
		ssrc:   ssrcFor(cfg.SelfKey.PublicKey()),
		cancel: cancel,
		peers:  make(map[wgtypes.Key]*peerState),
		byAddr: make(map[netip.Addr]*peerState),
	}
	e.wg.Add(2)
	go e.sendLoop(ctx)
	go e.recvLoop(ctx)
	return e, nil
}

// Stop tears down the loops, device and socket.
func (e *Engine) Stop() {
	e.cancel()
	e.conn.Close() // unblock recvLoop's ReadFrom
	e.dev.Close()
	e.wg.Wait()
}

// UpdatePeers reconciles voice membership with the current mesh. New peers get a
// pairwise key; departed peers are dropped. Errors deriving a key skip that peer
// (it simply won't be secure) rather than failing the whole update.
func (e *Engine) UpdatePeers(peers []PeerInfo) {
	e.mu.Lock()
	defer e.mu.Unlock()
	want := make(map[wgtypes.Key]struct{}, len(peers))
	for _, p := range peers {
		want[p.PublicKey] = struct{}{}
		if st, ok := e.peers[p.PublicKey]; ok {
			if st.info.VPN4 != p.VPN4 { // peer IP changed
				delete(e.byAddr, st.info.VPN4)
				st.info.VPN4 = p.VPN4
				e.byAddr[p.VPN4] = st
			}
			continue
		}
		st := e.newPeerLocked(p)
		e.peers[p.PublicKey] = st
		if p.VPN4.IsValid() {
			e.byAddr[p.VPN4] = st
		}
	}
	for key, st := range e.peers {
		if _, keep := want[key]; !keep {
			delete(e.peers, key)
			delete(e.byAddr, st.info.VPN4)
		}
	}
}

func (e *Engine) newPeerLocked(p PeerInfo) *peerState {
	st := &peerState{info: p, jitter: newJitterBuffer(defaultJitterDepth)}
	key, err := pairKey(e.cfg.SelfKey, p.PublicKey)
	if err != nil {
		return st // insecure; no sealer/opener → won't tx/rx to this peer
	}
	peerSSRC := ssrcFor(p.PublicKey)
	if s, err := newSealer(key, e.ssrc); err == nil {
		st.sealer = s
	}
	if o, err := newOpener(key, peerSSRC); err == nil {
		st.opener = o
	}
	st.secure = st.sealer != nil && st.opener != nil
	return st
}

const defaultJitterDepth = 3

// SetMute stops/resumes sending local audio.
func (e *Engine) SetMute(muted bool) {
	e.mu.Lock()
	e.muted = muted
	e.mu.Unlock()
}

// SetDeafen stops/resumes local playback (and implies not rendering peers).
func (e *Engine) SetDeafen(deafened bool) {
	e.mu.Lock()
	e.deafened = deafened
	e.mu.Unlock()
}

// sendLoop reads capture frames, encodes+encrypts once, and fans out to peers.
func (e *Engine) sendLoop(ctx context.Context) {
	defer e.wg.Done()
	capture := e.dev.Capture()
	for {
		select {
		case <-ctx.Done():
			return
		case pcm, ok := <-capture:
			if !ok {
				return
			}
			e.broadcast(pcm)
		}
	}
}

func (e *Engine) broadcast(pcm []int16) {
	e.mu.Lock()
	if e.muted {
		e.mu.Unlock()
		return
	}
	payload, err := e.codec.Encode(pcm)
	if err != nil {
		e.mu.Unlock()
		return
	}
	seq, ts := e.seq, e.ts
	e.seq++
	e.ts += FrameSamples
	type target struct {
		st   *peerState
		addr netip.AddrPort
	}
	targets := make([]target, 0, len(e.peers))
	for _, st := range e.peers {
		if st.sealer == nil || !st.info.VPN4.IsValid() {
			continue
		}
		targets = append(targets, target{st, netip.AddrPortFrom(st.info.VPN4, VoicePort)})
	}
	e.mu.Unlock()

	for _, t := range targets {
		_, aad, err := marshalHeader(seq, ts, e.ssrc)
		if err != nil {
			continue
		}
		e.mu.Lock()
		ct, counter := t.st.sealer.seal(payload, aad)
		e.mu.Unlock()
		datagram := assemble(aad, ct, counter)
		if _, err := e.conn.WriteToUDPAddrPort(datagram, t.addr); err == nil {
			e.mu.Lock()
			t.st.txPackets++
			e.mu.Unlock()
		}
	}
}

// recvLoop reads datagrams, decrypts+decodes into the sender's jitter buffer.
func (e *Engine) recvLoop(ctx context.Context) {
	defer e.wg.Done()
	buf := make([]byte, 2048)
	for {
		n, from, err := e.conn.ReadFromUDPAddrPort(buf)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				return // socket closed
			}
		}
		e.handleDatagram(buf[:n], from.Addr())
	}
}

func (e *Engine) handleDatagram(datagram []byte, from netip.Addr) {
	pkt, err := parsePacket(datagram)
	if err != nil {
		return
	}
	e.mu.Lock()
	st := e.byAddr[from]
	if st == nil || st.opener == nil {
		e.mu.Unlock()
		return // unknown/insecure sender
	}
	opener := st.opener
	e.mu.Unlock()

	plain, err := opener.open(pkt.ciphertext, pkt.aad, pkt.counter)
	if err != nil {
		return // replay, tamper, or wrong key
	}
	pcm, err := e.codec.Decode(plain)
	if err != nil {
		return
	}
	// All jitter-buffer access stays under e.mu (Status reads it too); only the
	// device render happens outside the lock so Playback can't block the engine.
	e.mu.Lock()
	st.rxPackets++
	st.lastRx = time.Now()
	st.jitter.push(pkt.header.SequenceNumber, pcm)
	frame, real := st.jitter.pop()
	render := real && !e.deafened
	e.mu.Unlock()

	if render {
		e.dev.Playback(frame)
	}
}

// Participant is a snapshot of one peer's voice state.
type Participant struct {
	PublicKey   wgtypes.Key
	Speaking    bool
	PacketsRx   uint64
	PacketsTx   uint64
	LossPercent float64
	Secure      bool
}

// Status is a snapshot of the whole session.
type Status struct {
	Muted        bool
	Deafened     bool
	NetworkID    string
	Codec        string
	Participants []Participant
}

// Status returns the current session snapshot.
func (e *Engine) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	parts := make([]Participant, 0, len(e.peers))
	for key, st := range e.peers {
		parts = append(parts, Participant{
			PublicKey:   key,
			Speaking:    !st.lastRx.IsZero() && now.Sub(st.lastRx) < speakingWindow,
			PacketsRx:   st.rxPackets,
			PacketsTx:   st.txPackets,
			LossPercent: st.jitter.lossPercent(),
			Secure:      st.secure,
		})
	}
	return Status{
		Muted:        e.muted,
		Deafened:     e.deafened,
		NetworkID:    e.cfg.NetworkID,
		Codec:        e.codec.Name(),
		Participants: parts,
	}
}
