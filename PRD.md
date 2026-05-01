# OurCord PRD

## 1. Product Summary

OurCord is a small-group communications platform for 5-10 people. Its core product promise is not "another chat app"; it is a private WireGuard overlay network with a Discord-like collaboration layer on top.

The network layer is part of the product, not an implementation detail:

- Media traffic runs through the VPN overlay instead of an SFU or MCU.
- Peer-to-peer paths are preferred; DERP is a reliability fallback.
- A-B-C relay chains are implemented through WireGuard `AllowedIPs`, so a reachable peer can relay traffic between two otherwise unreachable peers.
- File storage is autonomous by default: user-owned servers first, shared servers next, lobby servers next, and platform R2 only as fallback.

## 2. Target Users And Jobs

Primary users:

- Small friend groups that want persistent voice, chat, and lightweight file sharing without operating a full community server.
- Gaming groups that need reliable voice plus LAN-like connectivity for games or private services.
- Small teams or families that prefer data autonomy and self-hosted relay or file infrastructure.

Core jobs:

- Create a private lobby and invite a few trusted members.
- Join voice with graceful fallback when direct networking fails.
- Exchange messages and files inside a lobby.
- Share local/self-hosted resources without exposing them to the public internet.
- Understand whether a connection is direct, relayed, or degraded.

Non-goals for MVP:

- Large public communities.
- Bot ecosystems, marketplace integrations, or complex moderation workflows.
- SFU/MCU-based large-room video.
- End-to-end encrypted stored message history.
- Full mobile media parity.

## 3. MVP Success Criteria

The MVP is successful when a small group can complete this path without manual database or network intervention:

1. A user logs in, creates a lobby, and creates an invite.
2. Another user joins the lobby with the invite.
3. Both devices register daemon peers and receive VPN addresses from the control layer.
4. The users can enter a voice-capable room and obtain a room-scoped peer config.
5. The daemon attempts direct connectivity and falls back to DERP when direct connectivity fails.
6. Text messages work in text and voice rooms.
7. R2-backed file upload, listing, download, quota enforcement, and expiry cleanup work.
8. Admin/owner role actions, bans, and relay deny lists take effect without waiting for JWT expiry.

Minimum network acceptance:

- Direct LAN/public endpoint paths work without manual endpoint injection.
- DERP fallback keeps at least 128 Kbps per connection for Opus-class voice.
- A-B-C chain routes are represented in WireGuard config when the control layer provides topology.
- The daemon reports enough state for UI to show VPN active, assigned addresses, peer count, and path status.

## 4. Product Scope By Phase

### Phase 1: Network Core

Status: not closed. The closure bar is automatic peer connectivity: no manual endpoint injection for direct P2P, and automatic DERP fallback when direct paths fail.

Included:

- Control Worker for auth, peer registration, IPAM, STUN/relay metadata, SignalDO, and bans.
- DERP relay server with control-plane heartbeat, ban-list sync, admission hook, and limiter.
- Daemon connection pipeline for Linux/macOS TUN, WireGuard userspace, IPC, config polling, and route application.
- Service Worker baseline for lobbies, rooms, invites, messages, file metadata, R2 fallback, and internal room membership lookup.
- CI for Workers, Go modules, and daemon cross-compile.

Known gaps:

- Per-peer ICE agents are not wired into the daemon connection loop.
- Daemon-side DERP client transport is still a placeholder.
- Manual endpoint hints are still needed for some end-to-end smoke tests.
- Windows address assignment and route sync are not implemented.
- UI and proto schemas are placeholders.

Exit criteria:

- Two real machines can connect directly through ICE without manual endpoint injection.
- A constrained network can fall back to DERP automatically and remain usable for the voice floor.
- Daemon status exposes per-peer path state: direct, DERP, next-hop, degraded, and last error.
- Phase 1 documentation no longer depends on mock endpoint injection for its primary acceptance path.

### Phase 2: Network Completeness

Goal: complete the network and autonomy contracts before investing in a full product UI.

Required:

- A-B-C topology calculation and route distribution, with daemon feedback when links degrade.
- Windows Wintun address assignment and route synchronization.
- Device-level credentials so one device can be revoked without invalidating all user sessions.
- HMAC(ts+nonce) signing for control-to-service internal RPC.
- Autonomous file backend protocol for user-owned, shared, and lobby servers; R2 remains the last fallback.
- Room-scoped peer refresh tied to lobby/room membership.
- Minimal CLI/status surfaces are enough for Phase 2 network acceptance; full UI moves after network completeness.

### Phase 3: Media Layer

Goal: deliver voice/video/screen-share/remote-control experiences on top of the VPN overlay.

Required:

- Opus voice path with mute/deafen, device selection, packet loss handling, and path-quality reporting.
- Video and screen-share negotiation with codec policy and bandwidth limits.
- Remote-control permission model and session lifecycle.
- UI state for active speakers, media errors, and degraded relay mode.

### Phase 4: Distribution And Polish

Goal: make OurCord installable and operable by non-developers.

Required:

- Desktop installer and privileged helper flow for daemon management.
- Relay and file-server setup guides for self-hosters.
- Automatic update strategy.
- Monitoring, logs, and operational dashboards for official infrastructure.
- Published security contact and release process.

## 5. Core User Journeys

### Create And Join A Lobby

- Owner creates a lobby.
- Service creates default `general` text room, `voice` room, and file policy.
- Owner creates an invite code with expiry and max-use limits.
- Invitee joins with the code.
- Members can list lobby rooms and members.

Acceptance:

- Single-use invites cannot be consumed by multiple concurrent joiners.
- Non-members cannot fetch lobby details, messages, files, or room member IDs.
- Admins can create rooms and invites; only owners can delete rooms or modify admin roles.

### Register A Device And Join The Overlay

- Daemon loads a token from `OURCORD_DAEMON_JWT` or `<state-dir>/token`.
- Daemon registers its WireGuard public key and DERP node key.
- Control allocates `198.18.0.0/15` IPv4 and deployment-random ULA IPv6.
- Daemon creates TUN, applies addresses/routes, starts WireGuard, and polls config.

Acceptance:

- IP allocation is unique under concurrent registration.
- Control and service use the same `JWT_SECRET`.
- Daemon status exposes VPN active state, IPs, and peer count.

### Enter A Voice-Capable Room

- UI asks daemon/control for room-scoped peer config.
- Control asks service for room member IDs through `SERVICE_INTERNAL_TOKEN`.
- SignalDO accepts only authenticated users whose peer key belongs to them and whose user is authorized for the room.
- Daemon establishes direct connectivity or falls back to DERP.

Acceptance:

- Non-members cannot connect to room signaling.
- Pair signaling only accepts sorted `pair:<pkA>-<pkB>` IDs and keys that belong to the pair.
- Users can see whether they are direct, DERP-relayed, or degraded.

### Send Messages

- Text and voice rooms accept text messages.
- Video and file rooms do not store text history.
- Message owners, admins, and owners can delete messages under the existing policy.

Acceptance:

- Message content and attachment references are bounded.
- Pagination returns chronological results.
- Service-layer text history is trusted-server plaintext for MVP.

### Share Files

- Client initiates upload with filename, size, MIME type, and optional storage preference.
- Service enforces file policy and picks the first available tier in the product priority order.
- R2 upload and download work through the Worker.
- Expired R2 files are cleaned by cron.

Acceptance:

- Declared and actual upload sizes must match.
- Non-members cannot list or download files.
- Non-R2 download returns a clear not-implemented response until the federated file protocol exists.

## 6. Security And Trust Requirements

- `JWT_SECRET` is shared by control and service; mismatches are deployment errors.
- User bans must invalidate outstanding JWTs on every authenticated control path.
- SignalDO must trust upstream authentication and must not duplicate room auth inside the Durable Object.
- Relay DERP admission uses DERP node keys, not WireGuard public keys.
- Control-to-service internal RPC currently uses `SERVICE_INTERNAL_TOKEN`; Phase 2 should replace it with HMAC timestamp/nonce signing.
- Daemon credentials are currently per-user; Phase 2 should introduce per-device credentials.
- Relay operators see metadata and encrypted traffic only; they must not see media or message contents carried over WireGuard.

## 7. Open Product Questions

- Whether mobile is a full media client or a control/chat-only client for the first release.
- Whether stored messages need optional E2EE later, despite not being planned for MVP.
- Whether Minecraft LAN support belongs in Phase 2 as a differentiator or remains a stretch feature after the core voice/file loop.

## 8. Documentation Acceptance

Documentation must stay aligned with current implementation:

- `README.md` is the user entry point.
- `AGENTS.md` files are implementation contracts for AI and contributors.
- `SECURITY.md` describes current trust boundaries and must not claim future HMAC/device credentials exist.
- `docs/ops/smoke-test.md` must match the current `198.18.0.0/15` and random ULA IPAM model.
- `proto/` and `ui/` placeholders should state what is missing without implying the feature already exists.
