import { Env, RelayServer } from "./types";
import { requireAuth, generateId } from "./auth";

// POST /api/relay/register — relay server self-registration / heartbeat
// Called by the relay server daemon itself (authenticated by server secret)
export async function registerRelay(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: ownerId } = authResult;

  const body = await request.json<{
    id?: string; // if updating existing registration
    region: string;
    hostname: string;
    port?: number;
    mode: "personal" | "lobby" | "rental";
    capacity_kbps?: number;
    // Optional load report sent on heartbeat for ranking in /api/relay/map.
    active_conns?: number;
    bytes_per_sec?: number;
  }>();

  if (!body.hostname || !body.region || !body.mode) {
    return json({ error: "hostname, region, mode required" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  if (body.id) {
    // Heartbeat update for existing relay
    const existing = await env.DB
      .prepare("SELECT id, owner_id FROM relay_servers WHERE id = ?")
      .bind(body.id)
      .first<{ id: string; owner_id: string }>();

    if (!existing) return json({ error: "Relay not found" }, 404);
    if (existing.owner_id !== ownerId) return json({ error: "Forbidden" }, 403);

    await env.DB
      .prepare("UPDATE relay_servers SET last_heartbeat = ?, active = 1 WHERE id = ?")
      .bind(now, body.id)
      .run();

    if (body.active_conns !== undefined || body.bytes_per_sec !== undefined) {
      await env.DB
        .prepare(
          `INSERT INTO relay_load (relay_id, active_conns, bytes_per_sec, reported_at)
           VALUES (?,?,?,?)
           ON CONFLICT(relay_id) DO UPDATE SET
             active_conns = excluded.active_conns,
             bytes_per_sec = excluded.bytes_per_sec,
             reported_at = excluded.reported_at`
        )
        .bind(body.id, body.active_conns ?? 0, body.bytes_per_sec ?? 0, now)
        .run();
    }

    await invalidateRelayCache(env);
    return json({ id: body.id, updated: true });
  }

  // New registration
  const id = generateId();
  await env.DB
    .prepare(
      `INSERT INTO relay_servers (id, owner_id, region, hostname, port, mode, capacity_kbps, active, registered_at, last_heartbeat)
       VALUES (?,?,?,?,?,?,?,1,?,?)`
    )
    .bind(
      id, ownerId, body.region, body.hostname,
      body.port ?? 443, body.mode, body.capacity_kbps ?? 10000,
      now, now
    )
    .run();

  await invalidateRelayCache(env);
  return json({ id }, 201);
}

// GET /api/relay/map — return relay server map (public, cached in KV).
// Optional ?region=<r> filters; results are ranked by available headroom
// (capacity_kbps - bytes_per_sec/1000) descending so the daemon picks the
// least-loaded relay first.
export async function getRelayMap(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const region = url.searchParams.get("region");

  // KV cache is region-keyed.
  const cacheKey = region ? `relay_map:${region}` : "relay_map";
  const cached = await env.KV.get(cacheKey, "json");
  if (cached) return json(cached);

  return json(await buildRelayMap(env, region));
}

// GET /api/relay/banned-keys — relay server pulls its denylist.
// Returns the union of global bans (target_type peer/user) and the per-relay
// denylist when ?relay_id=<id> is supplied. Authenticated by relay token.
export async function getBannedKeys(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const relayId = url.searchParams.get("relay_id");

  const now = Math.floor(Date.now() / 1000);
  const banned = await env.DB
    .prepare(
      `SELECT p.public_key FROM peers p
       JOIN bans b ON b.target_type = 'peer' AND b.target_id = p.id
       WHERE (b.expires_at IS NULL OR b.expires_at > ?)
       UNION
       SELECT p.public_key FROM peers p
       JOIN users u ON p.user_id = u.id
       JOIN bans b ON b.target_type = 'user' AND b.target_id = u.id
       WHERE (b.expires_at IS NULL OR b.expires_at > ?)`
    )
    .bind(now, now)
    .all<{ public_key: string }>();

  const keys = new Set(banned.results.map((r) => r.public_key));

  if (relayId) {
    const denied = await env.DB
      .prepare("SELECT public_key FROM relay_denied_peers WHERE relay_id = ?")
      .bind(relayId)
      .all<{ public_key: string }>();
    for (const r of denied.results) keys.add(r.public_key);
  }

  return json({ keys: [...keys] });
}

// POST /api/relay/:relay_id/deny — relay owner adds a peer-key to its denylist.
// Body: { public_key, reason? }
export async function denyPeerOnRelay(request: Request, env: Env, relayId: string): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const relay = await env.DB
    .prepare("SELECT owner_id FROM relay_servers WHERE id = ?")
    .bind(relayId).first<{ owner_id: string }>();
  if (!relay) return json({ error: "Relay not found" }, 404);
  if (relay.owner_id !== authResult.sub) return json({ error: "Forbidden" }, 403);

  const body = await request.json<{ public_key: string; reason?: string }>();
  if (!body.public_key) return json({ error: "public_key required" }, 400);

  await env.DB
    .prepare(
      `INSERT INTO relay_denied_peers (relay_id, public_key, reason, created_at)
       VALUES (?,?,?,?)
       ON CONFLICT(relay_id, public_key) DO UPDATE SET reason = excluded.reason`
    )
    .bind(relayId, body.public_key, body.reason ?? "", Math.floor(Date.now() / 1000))
    .run();
  await env.KV.delete("banned_keys_cache");
  return json({ denied: true });
}

// DELETE /api/relay/:relay_id/deny/:public_key — remove from denylist
export async function allowPeerOnRelay(request: Request, env: Env, relayId: string, publicKey: string): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const relay = await env.DB
    .prepare("SELECT owner_id FROM relay_servers WHERE id = ?")
    .bind(relayId).first<{ owner_id: string }>();
  if (!relay) return json({ error: "Relay not found" }, 404);
  if (relay.owner_id !== authResult.sub) return json({ error: "Forbidden" }, 403);

  await env.DB
    .prepare("DELETE FROM relay_denied_peers WHERE relay_id = ? AND public_key = ?")
    .bind(relayId, publicKey)
    .run();
  await env.KV.delete("banned_keys_cache");
  return json({ removed: true });
}

async function buildRelayMap(env: Env, region: string | null) {
  const now = Math.floor(Date.now() / 1000);
  const params: (string | number)[] = [now - 120];
  let q =
    `SELECT r.id, r.region, r.hostname, r.port, r.mode, r.capacity_kbps,
            COALESCE(l.active_conns, 0) AS active_conns,
            COALESCE(l.bytes_per_sec, 0) AS bytes_per_sec
     FROM relay_servers r
     LEFT JOIN relay_load l ON l.relay_id = r.id
     WHERE r.active = 1 AND r.last_heartbeat > ?`;
  if (region) { q += " AND r.region = ?"; params.push(region); }

  const relays = await env.DB.prepare(q).bind(...params).all<RelayServer & { active_conns: number; bytes_per_sec: number }>();

  // Rank by free headroom (kbps), descending. Relays without load info treated
  // as fully available so brand-new ones get a fair shake.
  const ranked = relays.results
    .map((r) => ({ ...r, headroom_kbps: r.capacity_kbps - Math.floor(r.bytes_per_sec * 8 / 1000) }))
    .sort((a, b) => b.headroom_kbps - a.headroom_kbps);

  const map = { relays: ranked, region, generated_at: now };
  const cacheKey = region ? `relay_map:${region}` : "relay_map";
  await env.KV.put(cacheKey, JSON.stringify(map), { expirationTtl: 60 });
  return map;
}

async function invalidateRelayCache(env: Env): Promise<void> {
  // Drop all region-scoped variants too. KV doesn't have wildcard delete in
  // the runtime; track with a list key. Simple approach: also delete a couple
  // common region keys plus the global one. For an MVP this is fine.
  await Promise.all([
    env.KV.delete("relay_map"),
    env.KV.delete("relay_map:cn"),
    env.KV.delete("relay_map:us"),
    env.KV.delete("relay_map:eu"),
    env.KV.delete("relay_map:ap"),
  ]);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
