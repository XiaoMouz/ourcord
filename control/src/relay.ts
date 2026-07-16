import { Env, RelayServer } from "./types";
import { requireAuth, requireAdmin, generateId, checkBodySize, constantTimeEqual, json } from "./auth";

// POST /api/relay/register — relay server self-registration / heartbeat
// Called by the relay server daemon itself (authenticated by server secret).
//
// H5: only `personal` mode is open to any authenticated user. `lobby` and
// `rental` modes are operator-controlled (anyone could otherwise stand up
// a "honeypot lobby relay" and intercept traffic), so they require the
// caller to be in ADMIN_USER_IDS. Lobby-owner-issued registration is a
// Phase-2 feature behind the service worker's permission system.
export async function registerRelay(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  // Peek body first to know which auth gate to apply, then re-process with
  // the appropriate one. We can't read the body twice, so we clone for the
  // auth-gated path.
  const cloned = request.clone();
  const peek = await request.json<{ mode?: string }>().catch(() => ({} as { mode?: string }));
  const requiresAdmin = peek.mode === "lobby" || peek.mode === "rental";
  const serverOwnerId = requiresAdmin ? authenticateOperatorRelay(cloned, env) : null;
  const authResult = serverOwnerId
    ? { sub: serverOwnerId }
    : requiresAdmin
      ? await requireAdmin(cloned, env)
      : await requireAuth(cloned, env);
  if (authResult instanceof Response) return authResult;
  const { sub: ownerId } = authResult;

  const body = await cloned.json<{
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

    // N2: in addition to liveness, refresh the operator-mutable metadata
    // (region/capacity/mode) so /api/relay/map doesn't keep serving the
    // values that were valid the day this row was first created. hostname
    // and port are part of the UNIQUE key — if those change the relay
    // would naturally fall through to the upsert path below, so we don't
    // touch them here.
    await env.DB
      .prepare(
        `UPDATE relay_servers
            SET last_heartbeat = ?, active = 1,
                region = ?, mode = ?, capacity_kbps = ?
          WHERE id = ?`
      )
      .bind(now, body.region, body.mode, body.capacity_kbps ?? 10000, body.id)
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

  // New registration. UPSERT against UNIQUE(owner_id,hostname,port) so a
  // relay that lost its persisted relay-id and re-registers reuses the same
  // row instead of creating a duplicate (then we look up the canonical id).
  // INSERT-OR-IGNORE keeps the original id stable.
  const id = generateId();
  await env.DB
    .prepare(
      `INSERT INTO relay_servers (id, owner_id, region, hostname, port, mode, capacity_kbps, active, registered_at, last_heartbeat)
       VALUES (?,?,?,?,?,?,?,1,?,?)
       ON CONFLICT(owner_id, hostname, port) DO UPDATE SET
         region = excluded.region,
         mode = excluded.mode,
         capacity_kbps = excluded.capacity_kbps,
         active = 1,
         last_heartbeat = excluded.last_heartbeat`
    )
    .bind(
      id, ownerId, body.region, body.hostname,
      body.port ?? 443, body.mode, body.capacity_kbps ?? 10000,
      now, now
    )
    .run();

  // Resolve the canonical id (existing if conflict, otherwise the new one).
  const row = await env.DB
    .prepare("SELECT id FROM relay_servers WHERE owner_id = ? AND hostname = ? AND port = ?")
    .bind(ownerId, body.hostname, body.port ?? 443)
    .first<{ id: string }>();
  const canonicalId = row?.id ?? id;

  await invalidateRelayCache(env);
  return json({ id: canonicalId }, 201);
}

// Official lobby/rental relays are long-running servers, while user JWTs are
// intentionally capped at one hour. Let an operator relay authenticate with
// the long-lived ADMIN_TOKEN and attribute its rows to the first configured
// admin user. Personal relays continue through normal user JWT authentication.
function authenticateOperatorRelay(request: Request, env: Env): string | null {
  const configured = env.ADMIN_TOKEN ?? "";
  const auth = request.headers.get("Authorization") ?? "";
  if (!configured || !auth.startsWith("Bearer ")) return null;
  if (!constantTimeEqual(auth.slice(7), configured)) return null;
  return (env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .find(Boolean) ?? null;
}

// GET /api/relay/map — return relay server map (public, cached in KV).
// Optional ?region=<r> filters; results are ranked by available headroom
// (capacity_kbps - bytes_per_sec/1000) descending so the daemon picks the
// least-loaded relay first.
// GET /api/relay/map — return relay server map (public, cached in KV).
// Optional ?region=<r> filters; results are ranked by available headroom
// (capacity_kbps - bytes_per_sec/1000) descending so the daemon picks the
// least-loaded relay first.
//
// J2: relays in `personal` mode are scoped to their owner — they do not
// appear in other users' maps. Otherwise any user could see the public
// hostnames/load of every personal relay (privacy leak), or stand up a
// fake `personal` relay and have strangers' clients pick it (steering
// metadata harvest). Cache key therefore embeds the caller's user-id.
export async function getRelayMap(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const userId = authResult.sub;

  const url = new URL(request.url);
  const region = url.searchParams.get("region");

  return json(await buildRelayMap(env, region, userId));
}

// GET /api/relay/banned-keys — relay server pulls its denylist.
// Returns the union of global bans (target_type peer/user) and the per-relay
// denylist when ?relay_id=<id> is supplied. Authenticated by relay token.
//
// Response shape:
//   { keys: [...wg_pub...], derp_keys: [...nodekey:HEX...] }
// `keys` is the WireGuard public key list (used to filter direct WG peers).
// `derp_keys` is the same set of users translated to DERP NodePublic format
// so the relay can reject banned clients at the DERP admit hook (see G12).
// Per-relay denylist entries are added to `keys`; their DERP equivalents
// are looked up via the peers table when present.
export async function getBannedKeys(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const relayId = url.searchParams.get("relay_id");

  const now = Math.floor(Date.now() / 1000);
  const banned = await env.DB
    .prepare(
      `SELECT p.public_key, p.derp_node_key FROM peers p
       JOIN bans b ON b.target_type = 'peer' AND b.target_id = p.id
       WHERE (b.expires_at IS NULL OR b.expires_at > ?)
       UNION
       SELECT p.public_key, p.derp_node_key FROM peers p
       JOIN users u ON p.user_id = u.id
       JOIN bans b ON b.target_type = 'user' AND b.target_id = u.id
       WHERE (b.expires_at IS NULL OR b.expires_at > ?)`
    )
    .bind(now, now)
    .all<{ public_key: string; derp_node_key: string }>();

  const keys = new Set<string>();
  const derpKeys = new Set<string>();
  for (const r of banned.results) {
    keys.add(r.public_key);
    if (r.derp_node_key) derpKeys.add(r.derp_node_key);
  }

  if (relayId) {
    const denied = await env.DB
      .prepare(
        `SELECT d.public_key, p.derp_node_key
         FROM relay_denied_peers d
         LEFT JOIN peers p ON p.public_key = d.public_key
         WHERE d.relay_id = ?`
      )
      .bind(relayId)
      .all<{ public_key: string; derp_node_key: string | null }>();
    for (const r of denied.results) {
      keys.add(r.public_key);
      if (r.derp_node_key) derpKeys.add(r.derp_node_key);
    }
  }

  return json({ keys: [...keys], derp_keys: [...derpKeys] });
}

// POST /api/relay/:relay_id/deny — relay owner adds a peer-key to its denylist.
// Body: { public_key, reason? }
export async function denyPeerOnRelay(request: Request, env: Env, relayId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
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
  return json({ removed: true });
}

export async function buildRelayMap(env: Env, region: string | null, userId: string) {
  const now = Math.floor(Date.now() / 1000);
  // J2: personal relays are visible only to their owner. The (mode <> 'personal'
  // OR owner_id = ?) clause keeps shared relays public while scoping personal
  // ones. Heartbeat freshness window is 120s.
  const params: (string | number)[] = [now - 120, userId];
  let q =
    `SELECT r.id, r.region, r.hostname, r.port, r.mode, r.capacity_kbps,
            COALESCE(l.active_conns, 0) AS active_conns,
            COALESCE(l.bytes_per_sec, 0) AS bytes_per_sec
     FROM relay_servers r
     LEFT JOIN relay_load l ON l.relay_id = r.id
     WHERE r.active = 1 AND r.last_heartbeat > ?
       AND (r.mode <> 'personal' OR r.owner_id = ?)`;
  if (region) { q += " AND r.region = ?"; params.push(region); }

  const relays = await env.DB.prepare(q).bind(...params).all<RelayServer & { active_conns: number; bytes_per_sec: number }>();

  // Rank by free headroom (kbps), descending. Relays without load info treated
  // as fully available so brand-new ones get a fair shake.
  const ranked = relays.results
    .map((r) => ({ ...r, headroom_kbps: r.capacity_kbps - Math.floor(r.bytes_per_sec * 8 / 1000) }))
    .sort((a, b) => b.headroom_kbps - a.headroom_kbps);

  return { relays: ranked, region, generated_at: now };
}

async function invalidateRelayCache(env: Env): Promise<void> {
  // J2: per-user relay-map caching was removed because the response now
  // depends on caller identity (personal-relay scoping). This helper is
  // kept as a no-op so existing call sites in registerRelay don't need
  // surgery; if/when caching returns it will need to walk per-user keys.
  void env;
}

