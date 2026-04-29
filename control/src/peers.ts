import { Env, Peer } from "./types";
import { requireAuth, generateId } from "./auth";
import { buildRelayMap } from "./relay";
import {
  ipsForOffset,
  nextCandidateOffset,
  commitOffset,
  isUniqueViolation,
} from "./ipam";

// POST /api/peers/register — register a new device/peer
// Body: { public_key: string, name: string, platform: string }
export async function registerPeer(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  const body = await request.json<{
    public_key: string;
    name: string;
    platform: string;
    derp_node_key?: string; // optional Tailscale DERP NodePublic.String() (G12)
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
      .prepare("UPDATE peers SET last_seen = ?, name = ?, platform = ?, derp_node_key = ? WHERE id = ?")
      .bind(Math.floor(Date.now() / 1000), body.name ?? "", body.platform, derpNodeKey, existing.id)
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
  let inserted: { ip4: string; ip6: string } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let candidate;
    try {
      candidate = ipsForOffset(offset);
    } catch {
      return json({ error: "VPN IP pool exhausted" }, 507);
    }
    try {
      await env.DB
        .prepare(
          "INSERT INTO peers (id, user_id, public_key, name, platform, last_seen, ip4, ip6, derp_node_key) VALUES (?,?,?,?,?,?,?,?,?)"
        )
        .bind(id, userId, body.public_key, body.name ?? "", body.platform, now, candidate.ip4, candidate.ip6, derpNodeKey)
        .run();
      inserted = { ip4: candidate.ip4, ip6: candidate.ip6 };
      // env.KV is a required binding so the previous `env.KV && ...` guard
      // (I8) was dead — drop it.
      await commitOffset(env.KV, offset);
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Race or stale counter — bump and retry.
      offset++;
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
        const resp = await fetch(`${env.SERVICE_URL}/api/internal/rooms/${encodeURIComponent(roomId)}/member-ids`, {
          headers: { "X-Internal-Token": env.SERVICE_INTERNAL_TOKEN },
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
        scopeWarning = `service fetch failed: ${(e as Error).message}`;
      }
    }
  }

  // H8: explicit column list — never `SELECT *`. derp_node_key is intentionally
  // excluded so it doesn't get fanned out to every mesh member; relays already
  // have their own feed via /api/relay/banned-keys.
  const placeholders = memberIds.map(() => "?").join(",");
  const peers = await env.DB
    .prepare(
      `SELECT id, user_id, public_key, name, platform, last_seen, ip4, ip6
       FROM peers WHERE user_id IN (${placeholders}) ORDER BY last_seen DESC`
    )
    .bind(...memberIds)
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

function buildWireGuardConfig(peer: Peer): string {
  return [
    "[Interface]",
    `# PublicKey = ${peer.public_key}`,
    `Address = ${peer.ip4}/10, ${peer.ip6}/48`,
    "DNS = 100.100.100.100",
    "",
  ].join("\n");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
