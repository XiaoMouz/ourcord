import { Env, Peer } from "./types";
import { requireAuth, generateId, checkBodySize, json } from "./auth";
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
    // J1: roomId is interpolated into a service-worker URL below. Validate the
    // shape (matches I4 normalization in index.ts) BEFORE encoding so we fail
    // closed on path-traversal attempts (e.g. "foo/../internal/admin/evil").
    if (!/^[a-z0-9-]{1,64}$/.test(roomId)) {
      return json({ error: "invalid room_id" }, 400);
    }
    if (!env.SERVICE_URL || !env.SERVICE_INTERNAL_TOKEN) {
      scopeWarning = "room scoping requested but SERVICE_URL/SERVICE_INTERNAL_TOKEN not configured";
    } else {
      try {
        // Defense in depth: encodeURIComponent even though the regex above
        // already excludes "/" and other reserved characters.
        // O1: 3s timeout matches the signal-route fetch (index.ts K7). Without
        // it a slow/half-dead service worker would stall every daemon's mesh
        // refresh up to the CF Worker 30s wall.
        const resp = await fetch(`${env.SERVICE_URL}/api/internal/rooms/${encodeURIComponent(roomId)}/member-ids`, {
          headers: { "X-Internal-Token": env.SERVICE_INTERNAL_TOKEN },
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
  const placeholders = memberIds.map(() => "?").join(",");
  const params: string[] = [...memberIds];
  let selfFilter = "";
  if (pubKey) {
    selfFilter = " AND public_key <> ?";
    params.push(pubKey);
  }
  const peers = await env.DB
    .prepare(
      `SELECT id, user_id, public_key, name, platform, last_seen, ip4, ip6, derp_node_key,
              wg_endpoint AS endpoint
       FROM peers WHERE user_id IN (${placeholders})${selfFilter} ORDER BY last_seen DESC`
    )
    .bind(...params)
    .all<Peer>();

  // J2: relay map is per-caller now (personal relays scoped to owner).
  // Query live; relay_servers is small. Region filter is N/A here — return
  // all visible relays so the daemon can pick by latency on its own.
  const relayMap = await buildRelayMap(env, null, userId);
  const relays = relayMap.relays;

  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (scopeWarning) headers["X-Scope-Warning"] = scopeWarning;
  return new Response(JSON.stringify({ peers: peers.results, relays }), { headers });
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
