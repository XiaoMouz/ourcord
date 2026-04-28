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

// GET /api/relay/map — return relay server map (public, cached in KV)
export async function getRelayMap(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // Serve from KV cache if fresh
  const cached = await env.KV.get("relay_map", "json");
  if (cached) return json(cached);

  return json(await buildRelayMap(env));
}

// GET /api/relay/banned-keys — called by relay servers to sync ban list
// Authenticated by relay server token
export async function getBannedKeys(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const now = Math.floor(Date.now() / 1000);
  // Return public keys of banned peers
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

  return json({ keys: banned.results.map((r) => r.public_key) });
}

async function buildRelayMap(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  // Only return relays with recent heartbeat (within 2 minutes)
  const relays = await env.DB
    .prepare(
      "SELECT id, region, hostname, port, mode, capacity_kbps FROM relay_servers WHERE active = 1 AND last_heartbeat > ?"
    )
    .bind(now - 120)
    .all<RelayServer>();

  const map = { relays: relays.results, generated_at: now };
  await env.KV.put("relay_map", JSON.stringify(map), { expirationTtl: 60 });
  return map;
}

async function invalidateRelayCache(env: Env): Promise<void> {
  await env.KV.delete("relay_map");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
