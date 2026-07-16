package ipc

import (
	ourcordv1 "github.com/ourcord/ourcord/daemon/pkg/pb/ourcordv1"
)

// Conversions between the daemon's domain types (DaemonStatus, ConnectedPeer —
// what the daemon core produces and pkg/client hands to presenters) and the
// wire types generated from proto/ourcord/v1/daemon.proto. The proto is the
// field source of truth; these helpers are the single mapping point in each
// direction, used by the daemon's gRPC service on one side and pkg/client on
// the other.

// pathToProto maps the daemon's path labels onto the frozen Path enum.
// Unknown labels map to PATH_UNSPECIFIED per the contract ("mandatory for
// absent or unrecognised values").
func pathToProto(s string) ourcordv1.Path {
	switch s {
	case "inactive":
		return ourcordv1.Path_PATH_INACTIVE
	case "no-peers":
		return ourcordv1.Path_PATH_NO_PEERS
	case "waiting":
		return ourcordv1.Path_PATH_WAITING
	case "direct":
		return ourcordv1.Path_PATH_DIRECT
	case "derp":
		return ourcordv1.Path_PATH_DERP
	case "next-hop":
		return ourcordv1.Path_PATH_NEXT_HOP
	case "degraded":
		return ourcordv1.Path_PATH_DEGRADED
	case "unresolved":
		return ourcordv1.Path_PATH_UNRESOLVED
	default:
		return ourcordv1.Path_PATH_UNSPECIFIED
	}
}

// pathFromProto is the inverse of pathToProto; PATH_UNSPECIFIED (and any enum
// value this build does not know) maps to the empty string.
func pathFromProto(p ourcordv1.Path) string {
	switch p {
	case ourcordv1.Path_PATH_INACTIVE:
		return "inactive"
	case ourcordv1.Path_PATH_NO_PEERS:
		return "no-peers"
	case ourcordv1.Path_PATH_WAITING:
		return "waiting"
	case ourcordv1.Path_PATH_DIRECT:
		return "direct"
	case ourcordv1.Path_PATH_DERP:
		return "derp"
	case ourcordv1.Path_PATH_NEXT_HOP:
		return "next-hop"
	case ourcordv1.Path_PATH_DEGRADED:
		return "degraded"
	case ourcordv1.Path_PATH_UNRESOLVED:
		return "unresolved"
	default:
		return ""
	}
}

// StatusToProto converts the daemon's status to its wire representation.
func StatusToProto(s DaemonStatus) *ourcordv1.DaemonStatus {
	return &ourcordv1.DaemonStatus{
		Running:        s.Running,
		VpnActive:      s.VPNActive,
		Ipv4:           s.IP4,
		Ipv6:           s.IP6,
		NetworkId:      s.NetworkID,
		PeerCount:      uint32(max(s.PeerCount, 0)),
		RelayUsed:      s.RelayUsed,
		RelayUrl:       s.RelayURL,
		PathSummary:    pathToProto(s.PathSummary),
		PathFlapsTotal: s.PathFlapsTotal,
		Transport:      transportToProto(s.Transport),
	}
}

// StatusFromProto converts a wire status back to the domain type. The legacy
// RoomID mirrors NetworkID: the proto intentionally omits room_id (network_id
// is the stable identifier), and the daemon has set both to the same value
// since the vpn_namespace migration.
func StatusFromProto(p *ourcordv1.DaemonStatus) DaemonStatus {
	if p == nil {
		return DaemonStatus{}
	}
	return DaemonStatus{
		Running:        p.GetRunning(),
		VPNActive:      p.GetVpnActive(),
		IP4:            p.GetIpv4(),
		IP6:            p.GetIpv6(),
		NetworkID:      p.GetNetworkId(),
		RoomID:         p.GetNetworkId(),
		PeerCount:      int(p.GetPeerCount()),
		RelayUsed:      p.GetRelayUsed(),
		RelayURL:       p.GetRelayUrl(),
		PathSummary:    pathFromProto(p.GetPathSummary()),
		PathFlapsTotal: p.GetPathFlapsTotal(),
		Transport:      transportFromProto(p.GetTransport()),
	}
}

// PeerToProto converts one connected peer to its wire representation.
func PeerToProto(c ConnectedPeer) *ourcordv1.ConnectedPeer {
	return &ourcordv1.ConnectedPeer{
		PublicKey:         c.PublicKey,
		Name:              c.Name,
		Ipv4:              c.IP4,
		Ipv6:              c.IP6,
		Direct:            c.Direct,
		Path:              pathToProto(c.Path),
		Endpoint:          c.Endpoint,
		CandidateEndpoint: c.CandidateEndpoint,
		RelayUrl:          c.RelayURL,
		NextHopPublicKey:  c.NextHop,
		LatencyMs:         c.LatencyMs,
		LastSeenSeconds:   c.LastSeenSecs,
		LastError:         c.LastError,
		PathTransitions:   c.PathTransitions,
		PathDwellSeconds:  c.PathDwellSecs,
		Flapping:          c.Flapping,
	}
}

// PeerFromProto converts a wire peer back to the domain type.
func PeerFromProto(p *ourcordv1.ConnectedPeer) ConnectedPeer {
	if p == nil {
		return ConnectedPeer{}
	}
	return ConnectedPeer{
		PublicKey:         p.GetPublicKey(),
		Name:              p.GetName(),
		IP4:               p.GetIpv4(),
		IP6:               p.GetIpv6(),
		Direct:            p.GetDirect(),
		Path:              pathFromProto(p.GetPath()),
		Endpoint:          p.GetEndpoint(),
		CandidateEndpoint: p.GetCandidateEndpoint(),
		RelayURL:          p.GetRelayUrl(),
		NextHop:           p.GetNextHopPublicKey(),
		LatencyMs:         p.GetLatencyMs(),
		LastSeenSecs:      p.GetLastSeenSeconds(),
		LastError:         p.GetLastError(),
		PathTransitions:   p.GetPathTransitions(),
		PathDwellSecs:     p.GetPathDwellSeconds(),
		Flapping:          p.GetFlapping(),
	}
}

// PeersToProto / PeersFromProto convert peer lists.
func PeersToProto(cs []ConnectedPeer) []*ourcordv1.ConnectedPeer {
	out := make([]*ourcordv1.ConnectedPeer, 0, len(cs))
	for _, c := range cs {
		out = append(out, PeerToProto(c))
	}
	return out
}

func PeersFromProto(ps []*ourcordv1.ConnectedPeer) []ConnectedPeer {
	out := make([]ConnectedPeer, 0, len(ps))
	for _, p := range ps {
		out = append(out, PeerFromProto(p))
	}
	return out
}

// VoiceStatusToProto converts a voice status snapshot to its wire form.
func VoiceStatusToProto(v VoiceStatus) *ourcordv1.VoiceStatus {
	parts := make([]*ourcordv1.VoiceParticipant, 0, len(v.Participants))
	for _, p := range v.Participants {
		parts = append(parts, &ourcordv1.VoiceParticipant{
			PublicKey:   p.PublicKey,
			Speaking:    p.Speaking,
			PacketsRx:   p.PacketsRx,
			PacketsTx:   p.PacketsTx,
			LossPercent: p.LossPercent,
			JitterMs:    p.JitterMs,
			Secure:      p.Secure,
		})
	}
	return &ourcordv1.VoiceStatus{
		Joined:       v.Joined,
		Muted:        v.Muted,
		Deafened:     v.Deafened,
		NetworkId:    v.NetworkID,
		Codec:        v.Codec,
		Participants: parts,
	}
}

// VoiceStatusFromProto converts a wire voice status back to the domain type.
func VoiceStatusFromProto(p *ourcordv1.VoiceStatus) VoiceStatus {
	if p == nil {
		return VoiceStatus{}
	}
	parts := make([]VoiceParticipant, 0, len(p.GetParticipants()))
	for _, pp := range p.GetParticipants() {
		parts = append(parts, VoiceParticipant{
			PublicKey:   pp.GetPublicKey(),
			Speaking:    pp.GetSpeaking(),
			PacketsRx:   pp.GetPacketsRx(),
			PacketsTx:   pp.GetPacketsTx(),
			LossPercent: pp.GetLossPercent(),
			JitterMs:    pp.GetJitterMs(),
			Secure:      pp.GetSecure(),
		})
	}
	return VoiceStatus{
		Joined:       p.GetJoined(),
		Muted:        p.GetMuted(),
		Deafened:     p.GetDeafened(),
		NetworkID:    p.GetNetworkId(),
		Codec:        p.GetCodec(),
		Participants: parts,
	}
}

func transportToProto(t TransportStats) *ourcordv1.TransportStats {
	return &ourcordv1.TransportStats{
		Mtu:                   uint32(max(t.MTU, 0)),
		IceSentPackets:        t.ICESentPackets,
		IceRecvPackets:        t.ICERecvPackets,
		IceRecvDrops:          t.ICERecvDrops,
		IceSendErrors:         t.ICESendErrors,
		IceRecvErrors:         t.ICERecvErrors,
		IceProbeSent:          t.ICEProbeSent,
		IceProbeAckSent:       t.ICEProbeAckSent,
		IceProbeAckReceived:   t.ICEProbeAckReceived,
		IceProbeTimeouts:      t.ICEProbeTimeouts,
		IceProbeInvalid:       t.ICEProbeInvalid,
		IceMaxPacketBytes:     t.ICEMaxPacketBytes,
		DerpSentPackets:       t.DERPSentPackets,
		DerpRecvPackets:       t.DERPRecvPackets,
		DerpRecvDrops:         t.DERPRecvDrops,
		DerpSuppressedPackets: t.DERPSuppressedPackets,
		DerpSendErrors:        t.DERPSendErrors,
		DerpRecvErrors:        t.DERPRecvErrors,
		DerpMaxPacketBytes:    t.DERPMaxPacketBytes,
	}
}

func transportFromProto(p *ourcordv1.TransportStats) TransportStats {
	if p == nil {
		return TransportStats{}
	}
	return TransportStats{
		MTU:                   int(p.GetMtu()),
		ICESentPackets:        p.GetIceSentPackets(),
		ICERecvPackets:        p.GetIceRecvPackets(),
		ICERecvDrops:          p.GetIceRecvDrops(),
		ICESendErrors:         p.GetIceSendErrors(),
		ICERecvErrors:         p.GetIceRecvErrors(),
		ICEProbeSent:          p.GetIceProbeSent(),
		ICEProbeAckSent:       p.GetIceProbeAckSent(),
		ICEProbeAckReceived:   p.GetIceProbeAckReceived(),
		ICEProbeTimeouts:      p.GetIceProbeTimeouts(),
		ICEProbeInvalid:       p.GetIceProbeInvalid(),
		ICEMaxPacketBytes:     p.GetIceMaxPacketBytes(),
		DERPSentPackets:       p.GetDerpSentPackets(),
		DERPRecvPackets:       p.GetDerpRecvPackets(),
		DERPRecvDrops:         p.GetDerpRecvDrops(),
		DERPSuppressedPackets: p.GetDerpSuppressedPackets(),
		DERPSendErrors:        p.GetDerpSendErrors(),
		DERPRecvErrors:        p.GetDerpRecvErrors(),
		DERPMaxPacketBytes:    p.GetDerpMaxPacketBytes(),
	}
}
