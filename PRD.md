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

Status: closed under the current Phase-1 acceptance bar. Room-scoped ICE direct
connectivity, startup DERP fallback, runtime DERP fallback under real network
impairment, 1:1 pair networks, service `vpn_namespace`, A-B-C next-hop routing,
and next-hop-to-direct recovery have all been validated with real
control/service/relay/daemon processes and OrbStack VMs, without manual
WireGuard endpoint injection as the primary acceptance path.

Included:

- Control Worker for auth, peer registration, IPAM, STUN/relay metadata, SignalDO, and bans.
- DERP relay server with control-plane heartbeat, ban-list sync, admission hook, and limiter.
- Daemon connection pipeline for Linux/macOS TUN, WireGuard userspace, IPC, config polling, and route application.
- Service Worker baseline for lobbies, rooms, invites, messages, file metadata, R2 fallback, and internal room membership lookup.
- CI for Workers, Go modules, and daemon cross-compile.

Recent validation:

- 2026-06-26: two OrbStack Ubuntu VMs entered the same service-backed room and
  reached `path_summary=direct` / peer `path=direct` over `ice://` endpoints.
  Bidirectional ICMP over `198.18.0.2/32` ↔ `198.18.0.3/32` and a TCP payload
  transfer succeeded with DERP counters at zero.
- 2026-06-26: the same direct path was re-run through a real service Worker
  product flow: create lobby, create invite, join lobby, create voice room,
  enter the returned `vpn_namespace`, and verify direct data-plane connectivity.
- 2026-06-26: 1:1 private-call networking was validated with a
  `pair:<pkA>.<pkB>` namespace. Pair-scoped PeerConfig returned the exact
  opposite device peer, SignalDO accepted the pair route, and the WireGuard data
  plane reached direct connectivity.
- 2026-06-26: startup DERP fallback was validated with real control + service +
  relay + two daemons. The daemons entered the same service `vpn_namespace` with
  `--disable-ice`, status reported `path_summary=derp`, DERP counters advanced,
  ICE counters stayed at zero, and bidirectional ICMP over
  `198.18.0.2/32` ↔ `198.18.0.3/32` succeeded through DERP.
- 2026-06-26: runtime fallback was validated in the same live setup through
  `ourcord-cli force-derp <peer_public_key>`. One daemon reached
  `path_summary=direct`; forcing fallback rewrote the peer route to DERP,
  both daemons reported `path_summary=degraded` / `relay_used=true`, and
  bidirectional ICMP stayed at 0% packet loss over DERP.
- 2026-06-26: control gained a `peer_connectivity` topology table and
  `/api/peers/connectivity` daemon report endpoint. Room-scoped `peers/config`
  now computes one-hop `next_hop_public_key` when A cannot directly reach C but
  both can reach B. Unit coverage verifies the A-B-C output contract and the
  local wrangler D1 migration was applied successfully during smoke.
- 2026-06-26: three OrbStack VMs entered one service `vpn_namespace` and control
  produced observed A-C/C-A `next-hop` routes through B after A-B and B-C
  connectivity reports.
- 2026-06-27: the topology model was split into `ice_direct` and `wg_reachable`.
  A three-VM OrbStack smoke then validated mixed next-hop over DERP-backed
  bottom edges: A-B and B-C were reported as `wg_reachable=true` /
  `ice_direct=false`, A-C was reported unreachable, A/C received
  `next-hop=B`, and bidirectional ICMP over A-C succeeded with TTL=63 and 0%
  packet loss. The daemon also disables Linux forwarding redirects and avoids
  assigning indirect peer AllowedIPs to the indirect peer itself, so WireGuard
  selects the next-hop peer for forwarded CIDRs.
- 2026-06-27: daemon now automatically reports startup DERP baseline edges as
  `ice_direct=false,wg_reachable=true` after a room/network config is applied.
  Unit coverage asserts this report on `enter-network`; live control logs also
  showed `/api/peers/connectivity` writes immediately after both daemons entered
  a service `vpn_namespace`.
- 2026-06-27: control topology selection now uses link costs instead of treating
  every `wg_reachable` edge as an equally good next-hop candidate. Direct ICE is
  cheapest, unknown/user WG relay is intermediate, and DERP baseline is most
  expensive. This prevents an all-DERP room from creating arbitrary A-B-C routes,
  while still allowing A-B-C to beat direct DERP when A-B and B-C are better
  edges. Unit coverage asserts both cases.
- 2026-06-27: runtime external-impairment fallback was validated with real
  service/control/relay/daemon processes. Two VMs joined a service-created
  `vpn_namespace`; one side reached validated `path_summary=direct`. Adding an
  OS-level IPv6 blackhole for the direct underlay path caused early VPN ping
  loss, then daemon direct-health detection switched the peer to
  `path_summary=degraded` over DERP and ping resumed. Control received
  `/api/peers/connectivity` rows with `transport=derp` and
  `wg_reachable=true`. A later fully symmetric UDP-drop smoke replaced the
  early retry-churn finding with sustained probe + exponential retry backoff.
- 2026-06-29: the current binary re-ran the symmetric runtime impairment smoke
  with real service/control/relay/daemon processes. Both peers first reached
  ICE direct, symmetric UDP egress drop forced DERP fallback with VPN ping
  staying at 0% loss, retry intervals backed off, and removing impairment
  restored ICE direct.
- 2026-06-29: three independent OrbStack VMs re-ran the A-B-C path without
  manual `/api/peers/connectivity` shaping. A-C UDP underlay was impaired while
  A-B/B-C stayed reachable; daemon reports drove control to emit
  `next_hop_public_key=B`, A/C showed `path=next-hop`, and bidirectional A-C
  VPN ICMP passed with TTL=63. The same run exposed and fixed stale direct-edge
  refresh plus next-hop recovery retry: after removing the A-C impairment,
  daemon kept probing direct ICE while still routed through B, cleared
  `NextHop`, reported `ice_direct=1`, and A-C ping returned to TTL=64 direct.

Known gaps:

- Connectivity reports have three async writers per edge (30s baseline
  refresh, 10s reachability monitor, ICE upgrade/degrade callbacks). The
  daemon now tags every report with a lifecycle epoch and monotonic sequence,
  and control stores only the reporter's source-owned directed edge. This
  prevents reordering and a peer's observation from fabricating the opposite
  direction; remaining work is path-flap telemetry and noise reduction.
- A-B-C mixed DERP data-plane forwarding has been validated. Startup DERP
  reachable-edge reports are automatic; daemon unreachable/direct recovery
  reports have code coverage and independent OrbStack VM smoke coverage. The
  repeatable single-VM / three-netns script remains the faster regression
  entrypoint.
- Legacy mock-control endpoint injection remains documented only as a fast
  regression path; it is no longer the primary direct-connect acceptance path.
- Room/network identity is being split into an explicit contract:
  `rooms.id` remains the service-layer business key for messages/files/CRUD,
  while `rooms.vpn_namespace` is accepted by control/service/daemon as the
  network namespace for voice/video/file overlays. Existing `room_id` query
  names remain for wire compatibility during the transition.
- Pair signaling exists in the control-layer SignalDO route and pair-scoped
  peer config now resolves the two exact device public keys; product-level
  private-call permission and UI flow still need full end-to-end validation.
- Windows address assignment and route sync are implemented via winipcfg
  (`daemon/pkg/tun/addr_windows.go`), validated by the `windows-native` CI job.
- UI remains a placeholder, but the client core is being separated from the
  interaction layer: `daemon/pkg/client` exposes typed, UI-agnostic daemon
  operations that the CLI (and a forthcoming TUI/GUIs) share.
  `proto/ourcord/v1/daemon.proto` freezes the daemon ↔ UI v1 contract and CI
  generates Go/TS bindings; the protobuf/gRPC wire-transport migration (replacing
  the JSON IPC adapter) remains open.

Implementation decisions to close:

- **Room identity contract**: `rooms.id` is the business identity used by
  service APIs (`messages`, `files`, room CRUD). `rooms.vpn_namespace` is the
  network identity for overlays. The service internal member lookup accepts
  either value; daemon exposes `enter-network <network_id>` while keeping
  `enter-room` as a compatibility alias.
- **`vpn_namespace` capacity model**: a namespace is a membership and policy
  scope, not a transport mode. One namespace can contain a 5-10 person voice
  mesh where each peer independently uses direct ICE, DERP, or later
  next-hop routing. It can also mix user-owned relay servers and official relay
  servers because relay choice is attached to the returned peer/relay config,
  not encoded into the namespace string. A-B-C or longer product dependencies
  should still be represented as per-peer route/topology output from control
  (`AllowedIPs` / `NextHop`) rather than by inventing nested namespace ids.
  Product-wise this means the namespace can represent multiplayer voice,
  P2P-only, P2P+DERP, user-relay+P2P, and A-B-C route chains. The control model
  now separates `ice_direct` from `wg_reachable`, so a DERP-backed peer edge can
  still be used as a valid next-hop when policy allows it.
- **Signal room conventions**: control currently accepts two SignalDO room id
  forms. Service-room ids map to lobby/room membership and should correspond
  to the same identity used for `peers/config`. `pair:<pkA>.<pkB>` maps to
  standalone 1:1 peer signaling without service membership. Decide whether
  pair signaling remains an internal/direct-connect primitive only, or whether
  it needs a matching peer-config path for product flows such as calls outside
  a lobby.
- **DERP fallback acceptance**: Phase 1 must prove both startup fallback
  (direct ICE is unavailable from the beginning) and runtime fallback (direct
  path fails after being established). The daemon should automatically route
  through DERP without manual endpoint injection and report the transition.
  Unit coverage now asserts startup DERP endpoint selection and runtime
  fallback from ICE to DERP. Real startup constrained-network DERP data-plane
  smoke is validated; runtime fallback is validated both through the diagnostic
  `force-derp` path and through a live OS route-blackhole impairment smoke.
- **Connectivity topology reports**: daemon/control now distinguish
  `ice_direct` from `wg_reachable` in `/api/peers/connectivity`. Control stores
  recent reachable edges per `network_id`, and `peers/config` derives a one-hop
  next-hop route only when the hop path is cheaper than the direct edge. Reports
  are mirrored because the transport edge is bidirectional for route selection.
  Runtime ICE fallback reports `ice_direct=false` while keeping
  `wg_reachable=true` when DERP remains configured and uses a
  `derp-fallback:<reason>` report reason. Startup DERP peer configs are also
  reported automatically as reachable baseline edges, but those DERP baseline
  edges carry high route cost and no longer create arbitrary relay chains by
  themselves.
- **ICE startup dedup/noise**: record and reduce the observed duplicate-start
  and gather-timeout noise (`attempted to start agent twice`, repeated
  `ice gather timeout`) so successful direct paths do not look degraded in
  logs or UI diagnostics.

Validated in the current Phase 1 smoke:

- A fully symmetric runtime impairment smoke now starts with both peers on ICE
  direct, applies a bidirectional UDP egress drop, falls back to DERP on both
  peers, keeps VPN ping working through DERP, backs failed ICE retry attempts
  off instead of retrying every tick, and returns to direct after impairment is
  removed.
- Daemon continues probing direct ICE for peers currently routed through
  `NextHop`; when the sustained probe validates recovery, it clears `NextHop`,
  restores direct `AllowedIPs`, switches WireGuard to `ice://`, and reports the
  direct edge back to control.
- Daemon status exposes per-peer path state (`direct`, `derp`, `next-hop`,
  `degraded`) plus `last_error`; the next-hop status case is covered by daemon
  unit tests.
- Control preserves `unreachable` topology evidence against ordinary periodic
  `derp-baseline` reports; daemon uses `derp-recovery` for an actual recovered
  baseline path so a dead edge can become reachable again without flapping.

Remaining exit criteria:

- Run the **Network release acceptance** GitHub workflow from a clean checkout
  before release. It runs `tests/e2e/smoke_abc_netns.sh`, which proves direct,
  runtime DERP, A-B-C next-hop, and post-impairment direct recovery; the
  independent-VM rerun remains environment evidence, not a manual gate.

### Phase 2: Network Completeness

Goal: complete the network and autonomy contracts before investing in a full product UI.

Required:

- Done: A-B-C topology calculation, route distribution, and daemon feedback
  when links degrade or recover.
- Done: device-level credentials so one device can be revoked without
  invalidating all user sessions.
- Done: HMAC(ts+nonce) signing for control-to-service internal RPC.
- Done: room-scoped peer refresh tied to lobby/room membership.
- Done: minimal CLI/status surfaces for current network acceptance.
- Done: autonomous file backend registry, sharing, fixed-chain selection,
  direct upload, completion verification, health checks, reference backend, and
  R2 fallback.
- Done: Windows Wintun address assignment and route synchronization (native
  winipcfg path in `daemon/pkg/tun/addr_windows.go`, validated by the
  `windows-native` CI job on a real Wintun adapter).
- Full UI remains Phase 4; Phase 2 only needs enough CLI/status surface to
  validate network behavior.

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

### Discord Mapping And Data Flow

- **Lobby** maps to a Discord server/guild. It owns membership, roles, invites,
  room list, file policy, and default relay/storage preferences.
- **Room** maps to a Discord channel. `rooms.id` is the service-layer channel id
  used by room CRUD, messages, files, and permissions.
- **`vpn_namespace`** is the network-layer id for a voice/video/file-capable
  room. Entering a namespace means "build an overlay with the members currently
  authorized for this room"; it does not decide whether the resulting packets
  are direct P2P, DERP-relayed, user-relay-backed, or next-hop routed.
- **Voice/video/screen-share packets** are sent over the daemon VPN data plane.
  Control and SignalDO only authorize membership and exchange ICE metadata;
  they do not carry media.
- **Text messages** are service-layer records. Text and voice rooms accept text
  messages; video and file rooms do not store text history in MVP.
- **Attachments/files** are service-layer metadata plus a storage backend chosen
  by policy. The intended priority chain is user-owned server → shared user
  server → lobby server → R2 fallback. R2 data flows through the Worker;
  non-R2 backends use direct `PUT` plus service `complete` verification before
  metadata is published.
- **1:1 private calls** use a `pair:<pkA>.<pkB>` network id today. That maps to
  two exact daemon device public keys rather than a lobby room. Product-level
  private-call permissions and call records still need to be attached above
  this primitive.

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

- Daemon prefers a device token from `OURCORD_DEVICE_TOKEN` or
  `<state-dir>/device.token`, exchanges it for short-lived auth, and still
  supports the legacy raw JWT path via `OURCORD_DAEMON_JWT` or
  `<state-dir>/token`.
- Daemon registers its WireGuard public key and DERP node key.
- Control allocates `198.18.0.0/15` IPv4 and deployment-random ULA IPv6.
- Daemon creates TUN, applies addresses/routes, starts WireGuard, and polls config.

Acceptance:

- IP allocation is unique under concurrent registration.
- Control and service use the same `JWT_SECRET`.
- Daemon status exposes VPN active state, IPs, and peer count.

### Enter A Voice-Capable Room

- UI asks daemon/control for room-scoped peer config.
- Control asks service for room member IDs through HMAC-signed internal RPC
  using `SERVICE_INTERNAL_TOKEN` as the shared key.
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
- Service enforces file policy and picks the first available tier in the fixed product priority order.
- R2 upload and download work through the Worker.
- Non-R2 upload goes directly to the selected backend and is published only
  after service verifies completion.
- Expired R2 files are cleaned by cron.

Acceptance:

- Declared and actual upload sizes must match.
- Non-members cannot list or download files.
- Non-R2 pending uploads are not listed or downloadable; completed non-R2 files
  return the selected backend URL when the backend is active.

## 6. Security And Trust Requirements

- `JWT_SECRET` is shared by control and service; mismatches are deployment errors.
- User bans must invalidate outstanding JWTs on every authenticated control path.
- SignalDO must trust upstream authentication and must not duplicate room auth inside the Durable Object.
- Relay DERP admission uses DERP node keys, not WireGuard public keys.
- Control-to-service internal RPC uses HMAC timestamp/nonce signing with
  `SERVICE_INTERNAL_TOKEN` as the shared key; the old static
  `X-Internal-Token` bearer shape must not be reintroduced.
- Daemon credentials are device-scoped through enroll/exchange/revoke flows;
  legacy raw JWT loading remains only as a compatibility path.
- Relay operators see metadata and encrypted traffic only; they must not see media or message contents carried over WireGuard.

## 7. Open Product Questions

- Whether mobile is a full media client or a control/chat-only client for the first release.
- Whether stored messages need optional E2EE later, despite not being planned for MVP.
- Whether Minecraft LAN support belongs in Phase 2 as a differentiator or remains a stretch feature after the core voice/file loop.

## 8. Documentation Acceptance

Documentation must stay aligned with current implementation:

- `README.md` is the user entry point.
- `AGENTS.md` files are implementation contracts for AI and contributors.
- `SECURITY.md` describes current trust boundaries and must not describe
  implemented HMAC/device credentials as future work.
- `docs/ops/smoke-test.md` must match the current `198.18.0.0/15` and random ULA IPAM model.
- `ui/` placeholders should state what is missing without implying the feature
  already exists. `proto/` must keep the daemon IPC schema and its compatibility
  rules aligned with the transitional JSON transport.
