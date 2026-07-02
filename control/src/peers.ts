import { Env, Peer } from "./types";
import { requireAuth, generateId, checkBodySize, json } from "./auth";
import { signInternalHeaders } from "./internalAuth";
import { buildRelayMap } from "./relay";
import { log } from "./log";
import {
  ipsForOffset,
  nextCandidateOffset,
  commitOffset,
  getULAPrefix,
  isUniqueViolation,
} from "./ipam";

// POST /api/peers/register — register a new device/peer
// Body: { public_key: string, name: string, platform: string }
export async function registerPeer(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  const body = await request.json<{
    public_key: string;
    name: string;
    platform: string;
    derp_node_key?: string; // optional Tailscale DERP NodePublic.String() (G12)
    wg_endpoint?: string; // optional host:port hint for manual/smoke direct WG
  }>();
  if (!body.public_key || !body.platform) {
    return json({ error: "public_key and platform required" }, 400);
  }
  // J3: WireGuard public keys are base64(32-byte) — exactly 43 chars + "="
  // padding. Reject anything else so junk can't reach the banned-keys feed,
  // wg-quick INI generator, or stored-XSS surface in any UI later.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(body.public_key)) {
    return json({ error: "public_key must be base64-encoded 32-byte WireGuard key" }, 400);
  }
  const derpNodeKey = (body.derp_node_key ?? "").trim();
  // Cheap sanity-check: tailcfg.NodePublic.String() always starts with this prefix.
  // Empty is allowed (legacy daemon); anything else gets rejected so a malformed
  // value can't pollute the banned-keys feed.
  if (derpNodeKey !== "" && !derpNodeKey.startsWith("nodekey:")) {
    return json({ error: "derp_node_key must start with 'nodekey:'" }, 400);
  }
  const wgEndpoint = (body.wg_endpoint ?? "").trim();
  if (
    wgEndpoint !== "" &&
    (wgEndpoint.length > 255 || /\s/.test(wgEndpoint) || !/:\d{1,5}$/.test(wgEndpoint))
  ) {
    return json({ error: "wg_endpoint must be a host:port endpoint" }, 400);
  }

  // Check for existing peer with same public key
  const existing = await env.DB
    .prepare("SELECT id, user_id FROM peers WHERE public_key = ?")
    .bind(body.public_key)
    .first<{ id: string; user_id: string }>();

  if (existing) {
    if (existing.user_id !== userId) {
      return json({ error: "Public key already registered to another user" }, 409);
    }
    // Update last_seen and return existing
    await env.DB
      .prepare("UPDATE peers SET last_seen = ?, name = ?, platform = ?, derp_node_key = ?, wg_endpoint = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), body.name ?? "", body.platform, derpNodeKey, wgEndpoint, existing.id)
      .run();
    const peer = await env.DB
      .prepare("SELECT * FROM peers WHERE id = ?")
      .bind(existing.id)
      .first<Peer>();
    return json({ peer, config: buildWireGuardConfig(peer!) });
  }

  // Atomic IP allocation: try offsets advancing past the KV counter,
  // relying on the UNIQUE constraint on peers.ip4 / peers.ip6 to detect
  // races with concurrent registrations. Bounded retry to avoid runaway
  // when the pool is genuinely contended.
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  const MAX_ATTEMPTS = 16;
  let offset = await nextCandidateOffset(env.KV);
  const ulaPrefix = await getULAPrefix(env.KV);
  let inserted: { ip4: string; ip6: string } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let candidate;
    try {
      candidate = ipsForOffset(offset, ulaPrefix);
    } catch {
      return json({ error: "VPN IP pool exhausted" }, 507);
    }
    try {
      await env.DB
        .prepare(
          "INSERT INTO peers (id, user_id, public_key, name, platform, last_seen, ip4, ip6, derp_node_key, wg_endpoint) VALUES (?,?,?,?,?,?,?,?,?,?)"
        )
        .bind(id, userId, body.public_key, body.name ?? "", body.platform, now, candidate.ip4, candidate.ip6, derpNodeKey, wgEndpoint)
        .run();
      inserted = { ip4: candidate.ip4, ip6: candidate.ip6 };
      // env.KV is a required binding so the previous `env.KV && ...` guard
      // (I8) was dead — drop it.
      await commitOffset(env.KV, offset);
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // O2: only the ip4/ip6 columns are racy here — the IP pool is the only
      // thing the loop knows how to fix by bumping `offset`. Other UNIQUE
      // collisions (most commonly `peers.public_key` from a register-vs-
      // register race that slipped past the SELECT above; theoretically
      // `peers.id`) need different handling, otherwise we burn 16 attempts
      // and surface a misleading 503 "VPN IP pool" error.
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed:\s*peers\.(ip4|ip6)/i.test(msg)) {
        offset++;
        continue;
      }
      if (/UNIQUE constraint failed:\s*peers\.public_key/i.test(msg)) {
        // Lost a register-register race; the other side won. Re-fetch and
        // return the existing row exactly like the pre-loop fast path.
        const winner = await env.DB
          .prepare("SELECT * FROM peers WHERE public_key = ?")
          .bind(body.public_key)
          .first<Peer>();
        if (winner && winner.user_id === userId) {
          return json({ peer: winner, config: buildWireGuardConfig(winner) });
        }
        return json({ error: "Public key already registered to another user" }, 409);
      }
      // Unknown unique constraint (e.g. peers.id ULID collision, or some
      // future column we don't know about). Don't burn the offset budget
      // pretending it's a pool issue.
      return json({ error: "constraint conflict" }, 409);
    }
  }

  if (!inserted) {
    return json({ error: "Could not allocate VPN IP after retries" }, 503);
  }

  const peer = await env.DB
    .prepare("SELECT * FROM peers WHERE id = ?")
    .bind(id)
    .first<Peer>();

  return json({ peer, config: buildWireGuardConfig(peer!) }, 201);
}

// GET /api/peers/config — get peer list for building WireGuard config.
//
// Without query params: returns all of this user's own peers (single-account
// mesh). With ?room_id=<id>: also returns peers belonging to other users who
// share that room. Per spec, "每个房间应属于单独的组网" — voice/video/file
// rooms get isolated tables; text rooms don't expose any peers (membership is
// purely chat-level).
//
// Cross-room peers are fetched by asking the service layer for the lobby's
// member user-ids and intersecting with our peers table. Requires
// SERVICE_URL + SERVICE_INTERNAL_TOKEN to be configured; without them
// room scoping is silently skipped (back to user-only mesh, with a warning
// header for client-side debugging).
export async function getPeerConfig(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  // Update last_seen for the requesting peer (identified by public key header)
  const pubKey = request.headers.get("X-Peer-Public-Key");
  if (pubKey) {
    await env.DB
      .prepare("UPDATE peers SET last_seen = ? WHERE user_id = ? AND public_key = ?")
      .bind(Math.floor(Date.now() / 1000), userId, pubKey)
      .run();
  }

  const url = new URL(request.url);
  const roomId = url.searchParams.get("room_id");

  let memberIds: string[] = [userId];
  let scopeWarning: string | null = null;

  if (roomId) {
    if (roomId.startsWith("pair:")) {
      const pair = parsePairRoom(roomId);
      if (!pair) return json({ error: "malformed pair room_id" }, 400);
      if (!pubKey || !pair.includes(pubKey)) {
        return json({ error: "requesting peer is not part of this pair" }, 403);
      }
      memberIds = [];
    } else if (!isNetworkID(roomId)) {
      // J1: roomId/network namespace is interpolated into a service-worker URL
      // below. Validate before encodeURIComponent so path traversal fails
      // closed. Keep the alphabet URL-path-safe and compatible with generated
      // vpn_namespace values.
      return json({ error: "invalid room_id" }, 400);
    }
    if (roomId.startsWith("pair:")) {
      // Pair configs are device-pair scoped and do not rely on service-layer
      // lobby membership. The SQL below switches from user_id membership to
      // exact public_key membership.
    } else if (!env.SERVICE_URL || !env.SERVICE_INTERNAL_TOKEN) {
      scopeWarning = "room scoping requested but SERVICE_URL/SERVICE_INTERNAL_TOKEN not configured";
    } else {
      try {
        // Defense in depth: encodeURIComponent even though the regex above
        // already excludes "/" and other reserved characters.
        // O1: 3s timeout matches the signal-route fetch (index.ts K7). Without
        // it a slow/half-dead service worker would stall every daemon's mesh
        // refresh up to the CF Worker 30s wall.
        // G6: signed short-lived headers instead of a static bearer token.
        const memberURL = `${env.SERVICE_URL}/api/internal/rooms/${encodeURIComponent(roomId)}/member-ids`;
        const resp = await fetch(memberURL, {
          headers: await signInternalHeaders(env.SERVICE_INTERNAL_TOKEN, "GET", memberURL),
          signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) {
          scopeWarning = `service returned ${resp.status} for room ${roomId}`;
        } else {
          const body = await resp.json<{ user_ids: string[] }>();
          // Caller must be a member; otherwise return empty mesh.
          if (!body.user_ids?.includes(userId)) {
            return json({ peers: [], relays: [], note: "not a member of this room" });
          }
          memberIds = body.user_ids;
        }
      } catch (e) {
        // L2: never leak the underlying error message (which may include
        // internal hostnames / IPs / connection-refused details) into a
        // response header. Emit a stable opaque code; full detail goes to
        // worker logs only.
        // O1: distinguish timeout (TimeoutError / AbortError) from generic
        // failure so client-side mesh refresh can back off appropriately.
        log({ event: "peers.service_fetch_failed", level: "warn", room_id: roomId, error: String(e) });
        const name = (e as { name?: string } | null)?.name;
        scopeWarning = name === "TimeoutError" || name === "AbortError"
          ? "service-fetch-timeout"
          : "service-fetch-failed";
      }
    }
  }

  // H8: explicit column list — never `SELECT *`. derp_node_key is included
  // because daemon-side DERP fallback needs each peer's DERP identity to route
  // WireGuard packets through a relay. Ban feeds still use /api/relay/banned-keys.
  const pairKeys = roomId?.startsWith("pair:") ? parsePairRoom(roomId) : null;
  const SELECT_PEERS = `SELECT id, user_id, public_key, name, platform, last_seen, ip4, ip6, derp_node_key,
              wg_endpoint AS endpoint
       FROM peers WHERE `;
  const selfFilter = pubKey ? " AND public_key <> ?" : "";
  let peerRows: Peer[];
  if (pairKeys) {
    const params: string[] = [...pairKeys];
    if (pubKey) params.push(pubKey);
    const peers = await env.DB
      .prepare(`${SELECT_PEERS}public_key IN (?,?)${selfFilter} ORDER BY last_seen DESC`)
      .bind(...params)
      .all<Peer>();
    peerRows = peers.results ?? [];
  } else {
    // G20: D1 caps a statement at ~100 bound parameters, and memberIds comes
    // straight from the service worker's response — never trust its size.
    // Query in chunks and merge, preserving the last_seen DESC ordering.
    const CHUNK = 90;
    peerRows = [];
    for (let i = 0; i < memberIds.length; i += CHUNK) {
      const chunk = memberIds.slice(i, i + CHUNK);
      const params: string[] = [...chunk];
      if (pubKey) params.push(pubKey);
      const placeholders = chunk.map(() => "?").join(",");
      const peers = await env.DB
        .prepare(`${SELECT_PEERS}user_id IN (${placeholders})${selfFilter} ORDER BY last_seen DESC`)
        .bind(...params)
        .all<Peer>();
      peerRows.push(...(peers.results ?? []));
    }
    if (memberIds.length > CHUNK) {
      peerRows.sort((a, b) => b.last_seen - a.last_seen);
    }
  }
  if (roomId && !pairKeys && pubKey && isNetworkID(roomId)) {
    await annotateNextHops(env, roomId, pubKey, peerRows);
  }

  // J2: relay map is per-caller now (personal relays scoped to owner).
  // Query live; relay_servers is small. Region filter is N/A here — return
  // all visible relays so the daemon can pick by latency on its own.
  const relayMap = await buildRelayMap(env, null, userId);
  const relays = relayMap.relays;

  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (scopeWarning) headers["X-Scope-Warning"] = scopeWarning;
  return new Response(JSON.stringify({ peers: peerRows, relays }), { headers });
}

// POST /api/peers/connectivity — daemon reports per-peer link capabilities in
// a network namespace. `ice_direct` is a direct UDP path; `wg_reachable` means
// the WireGuard peer remains usable through some transport (ICE, DERP, or a
// user relay). Next-hop routing uses a cost model: direct ICE is preferred,
// DERP is the most expensive baseline, and one-hop relay is selected only when
// it improves on the direct edge or the direct edge is unavailable.
export async function reportPeerConnectivity(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  const selfKey = request.headers.get("X-Peer-Public-Key") ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(selfKey)) {
    return json({ error: "X-Peer-Public-Key required" }, 400);
  }
  const owned = await env.DB
    .prepare("SELECT 1 FROM peers WHERE public_key = ? AND user_id = ?")
    .bind(selfKey, userId)
    .first();
  if (!owned) return json({ error: "peer not owned by user" }, 403);

  let body: {
    network_id?: unknown;
    peer_public_key?: unknown;
    direct?: unknown;
    ice_direct?: unknown;
    wg_reachable?: unknown;
    transport?: unknown;
    rtt_ms?: unknown;
    reason?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const networkID = typeof body.network_id === "string" ? body.network_id.trim() : "";
  const peerKey = typeof body.peer_public_key === "string" ? body.peer_public_key.trim() : "";
  // Accept the same two roomId conventions as getPeerConfig: a network namespace
  // (alphanumeric/hyphen) or a 1:1 "pair:<keyA>.<keyB>" room. parsePairRoom decodes
  // to the two standard-base64 member keys; a pair report is only authorized when
  // the caller and the reported peer are exactly those two members (checked below,
  // once peerKey format is validated).
  const pair = networkID.startsWith("pair:") ? parsePairRoom(networkID) : null;
  if (networkID.startsWith("pair:")) {
    if (!pair) return json({ error: "invalid pair network_id" }, 400);
  } else if (!isNetworkID(networkID)) {
    return json({ error: "invalid network_id" }, 400);
  }
  if (!/^[A-Za-z0-9+/]{43}=$/.test(peerKey)) return json({ error: "invalid peer_public_key" }, 400);
  if (peerKey === selfKey) return json({ error: "peer_public_key must differ from self" }, 400);
  if (pair && !(pair.includes(selfKey) && pair.includes(peerKey))) {
    return json({ error: "peers are not part of this pair" }, 403);
  }
  const legacyDirect = body.direct === true;
  const iceDirect = body.ice_direct === true || legacyDirect;
  const wgReachable = typeof body.wg_reachable === "boolean" ? body.wg_reachable : legacyDirect;
  const requestedTransport = typeof body.transport === "string" ? body.transport.trim() : "";
  const rttMs = typeof body.rtt_ms === "number" && Number.isFinite(body.rtt_ms)
    ? Math.max(0, Math.min(600_000, Math.round(body.rtt_ms)))
    : null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 128) : "";
  const transport = normalizeConnectivityTransport(requestedTransport, iceDirect, wgReachable, reason);
  const now = Math.floor(Date.now() / 1000);

  // TODO(topology): both directed edges are written with identical values, so
  // asymmetric reachability (A reaches C but not vice-versa) isn't representable.
  // Acceptable for the symmetric "dead edge" case the daemon reports today; if
  // per-direction reachability is ever needed, split the two upserts' values.
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO peer_connectivity
           (network_id, src_public_key, dst_public_key, direct, ice_direct, wg_reachable, transport, rtt_ms, reason, reported_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(network_id, src_public_key, dst_public_key)
         DO UPDATE SET direct = excluded.direct, ice_direct = excluded.ice_direct,
                       wg_reachable = excluded.wg_reachable, transport = excluded.transport, rtt_ms = excluded.rtt_ms,
                       reason = excluded.reason, reported_at = excluded.reported_at
         WHERE NOT (
           peer_connectivity.wg_reachable = 0
           AND peer_connectivity.reason = 'unreachable'
           AND excluded.wg_reachable = 1
           AND excluded.ice_direct = 0
           AND excluded.reason = 'derp-baseline'
         )`,
      ).bind(networkID, selfKey, peerKey, iceDirect ? 1 : 0, iceDirect ? 1 : 0, wgReachable ? 1 : 0, transport, rttMs, reason, now),
      env.DB.prepare(
        `INSERT INTO peer_connectivity
           (network_id, src_public_key, dst_public_key, direct, ice_direct, wg_reachable, transport, rtt_ms, reason, reported_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(network_id, src_public_key, dst_public_key)
         DO UPDATE SET direct = excluded.direct, ice_direct = excluded.ice_direct,
                       wg_reachable = excluded.wg_reachable, transport = excluded.transport, rtt_ms = excluded.rtt_ms,
                       reason = excluded.reason, reported_at = excluded.reported_at
         WHERE NOT (
           peer_connectivity.wg_reachable = 0
           AND peer_connectivity.reason = 'unreachable'
           AND excluded.wg_reachable = 1
           AND excluded.ice_direct = 0
           AND excluded.reason = 'derp-baseline'
         )`,
      ).bind(networkID, peerKey, selfKey, iceDirect ? 1 : 0, iceDirect ? 1 : 0, wgReachable ? 1 : 0, transport, rttMs, reason, now),
    ]);
  } catch (e) {
    log({ event: "peers.connectivity_write_failed", level: "error", network_id: networkID, error: String(e) });
    return json({ error: "connectivity table unavailable" }, 503);
  }

  return json({ ok: true });
}

async function annotateNextHops(env: Env, networkID: string, selfKey: string, peers: Peer[]): Promise<void> {
  if (peers.length < 2) return;
  const peerKeys = peers.map((p) => p.public_key).filter(Boolean);
  const graphKeys = [selfKey, ...peerKeys];
  // G20: D1 caps a prepared statement at ~100 bound parameters. graphKeys is
  // bound TWICE below (src IN + dst IN) plus network_id and the timestamp, so
  // the real count is 2 + 2N — the guard must be N ≤ 49, not N ≤ 100.
  // Next-hop annotation is an optimization, so oversize networks just skip it.
  if (graphKeys.length > 49) {
    log({ event: "peers.topology_too_large", level: "warn", network_id: networkID, count: graphKeys.length });
    return;
  }
  const placeholders = graphKeys.map(() => "?").join(",");
  let rows: Array<{
    src_public_key: string;
    dst_public_key: string;
    ice_direct: number;
    wg_reachable: number;
    transport: string;
    reason: string;
  }>;
  try {
    const res = await env.DB
      .prepare(
        `SELECT src_public_key, dst_public_key, ice_direct, wg_reachable, transport, reason
         FROM peer_connectivity
         WHERE network_id = ?
           AND wg_reachable = 1
           AND reported_at > ?
           AND src_public_key IN (${placeholders})
           AND dst_public_key IN (${placeholders})`,
      )
      .bind(networkID, Math.floor(Date.now() / 1000) - 120, ...graphKeys, ...graphKeys)
      .all<{
        src_public_key: string;
        dst_public_key: string;
        ice_direct: number;
        wg_reachable: number;
        transport: string;
        reason: string;
      }>();
    rows = res.results ?? [];
  } catch (e) {
    // Older local DBs may not have run 0003 yet. Keep peer config usable and
    // log the missing topology instead of failing room entry.
    log({ event: "peers.topology_read_failed", level: "warn", network_id: networkID, error: String(e) });
    return;
  }
  const edges = new Map(rows.map((r) => [`${r.src_public_key}\n${r.dst_public_key}`, r]));
  const edgeCost = (a: string, b: string): number => {
    const edge = edges.get(`${a}\n${b}`);
    if (!edge || edge.wg_reachable !== 1) return Number.POSITIVE_INFINITY;
    if (edge.ice_direct === 1) return 10;
    if (edge.transport === "wg_relay") return 100;
    if (edge.transport === "derp") return 1000;
    // DERP is a reliable fallback, but it should not create arbitrary
    // A-B-C paths when every pair is merely DERP-reachable. Unknown
    // non-DERP WG transports, including user relays, sit between ICE and DERP.
    return edge.reason.startsWith("derp") ? 1000 : 100;
  };
  for (const target of peers) {
    const directCost = edgeCost(selfKey, target.public_key);
    let bestHop: Peer | null = null;
    let bestHopCost = directCost;
    for (const candidate of peers) {
      if (candidate.public_key === target.public_key) continue;
      const hopCost = edgeCost(selfKey, candidate.public_key) + edgeCost(candidate.public_key, target.public_key) + 5;
      if (hopCost < bestHopCost) {
        bestHop = candidate;
        bestHopCost = hopCost;
      }
    }
    if (bestHop) target.next_hop_public_key = bestHop.public_key;
  }
}

function isNetworkID(s: string): boolean {
  return /^[A-Za-z0-9-]{1,128}$/.test(s);
}

function normalizeConnectivityTransport(requested: string, iceDirect: boolean, wgReachable: boolean, reason: string): "" | "ice" | "derp" | "wg_relay" {
  if (!wgReachable) return "";
  if (iceDirect) return "ice";
  if (requested === "derp" || requested === "wg_relay") return requested;
  if (requested === "ice") return "ice";
  if (reason.startsWith("derp")) return "derp";
  return "";
}

function parsePairRoom(roomId: string): [string, string] | null {
  const body = roomId.slice("pair:".length);
  const parts = body.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (parts[0] > parts[1]) return null;
  const a = decodeBase64URLKey(parts[0]);
  const b = decodeBase64URLKey(parts[1]);
  if (!a || !b) return null;
  return [a, b];
}

function decodeBase64URLKey(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  try {
    const bin = atob(padded);
    if (bin.length !== 32) return null;
    return btoa(bin);
  } catch {
    return null;
  }
}

interface RelayEntry {
  hostname: string;
  port: number;
  region: string;
  ipv4?: string;
  ipv6?: string;
}

// POST /api/peers/lookup — batch resolve user_ids to peer wireguard info.
//
// Body: { user_ids: string[] } (max 100, deduped server-side)
// Response: { peers: { [user_id]: [{ public_key, ip4, ip6, derp_node_key, last_seen }, ...] } }
//
// Used by the daemon when joining a voice/video room: it gets the room
// member user_ids from the service layer and needs to map them to peer
// keys + endpoints in a single round-trip (replaces the old N+1 pattern).
// Users with no registered peers are omitted from the map (callers
// shouldn't need to distinguish "absent" from "empty array").
export async function lookupPeers(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 16 * 1024);
  if (tooBig) return tooBig;
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  let body: { user_ids?: unknown };
  try {
    body = await request.json<{ user_ids?: unknown }>();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.user_ids)) {
    return json({ error: "user_ids must be an array" }, 400);
  }
  if (body.user_ids.length === 0) {
    return json({ error: "user_ids must be a non-empty array" }, 400);
  }
  if (body.user_ids.length > 100) {
    return json({ error: "too many user_ids, max 100" }, 400);
  }
  // Skip non-strings rather than fail outright — keeps the API permissive
  // for callers that mix ids from heterogeneous sources.
  const ids = Array.from(
    new Set(body.user_ids.filter((v): v is string => typeof v === "string")),
  );
  if (ids.length === 0) {
    return json({ peers: {} });
  }

  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB
    .prepare(
      `SELECT user_id, public_key, ip4, ip6, derp_node_key, last_seen
       FROM peers WHERE user_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      user_id: string;
      public_key: string;
      ip4: string;
      ip6: string;
      derp_node_key: string;
      last_seen: number;
    }>();

  const peers: Record<string, Array<{
    public_key: string;
    ip4: string;
    ip6: string;
    derp_node_key: string;
    last_seen: number;
  }>> = {};
  for (const r of rows.results ?? []) {
    const list = peers[r.user_id] ?? (peers[r.user_id] = []);
    list.push({
      public_key: r.public_key,
      ip4: r.ip4,
      ip6: r.ip6,
      derp_node_key: r.derp_node_key,
      last_seen: r.last_seen,
    });
  }
  return json({ peers });
}

function buildWireGuardConfig(peer: Peer): string {
  return [
    "[Interface]",
    `# PublicKey = ${peer.public_key}`,
    `Address = ${peer.ip4}/10, ${peer.ip6}/48`,
    "DNS = 100.100.100.100",
    "",
  ].join("\n");
}
