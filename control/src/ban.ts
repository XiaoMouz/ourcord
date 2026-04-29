import { Env } from "./types";
import { requireAuth, requireAdmin, generateId } from "./auth";

// POST /api/ban — admin: ban a user, peer, or relay
export async function createBan(request: Request, env: Env): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;

  const body = await request.json<{
    target_type: "user" | "peer" | "relay";
    target_id: string;
    reason?: string;
    expires_in_seconds?: number;
  }>();

  if (!body.target_type || !body.target_id) {
    return json({ error: "target_type and target_id required" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const id = generateId();
  const expiresAt = body.expires_in_seconds ? now + body.expires_in_seconds : null;

  await env.DB
    .prepare("INSERT INTO bans (id, target_type, target_id, reason, created_at, expires_at) VALUES (?,?,?,?,?,?)")
    .bind(id, body.target_type, body.target_id, body.reason ?? "", now, expiresAt)
    .run();

  // Notify relay servers by invalidating cached banned keys
  await env.KV.delete("banned_keys_cache");

  return json({ id, target_type: body.target_type, target_id: body.target_id }, 201);
}

// DELETE /api/ban/:id — remove a ban (admin only)
export async function removeBan(request: Request, env: Env, banId: string): Promise<Response> {
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  await env.DB.prepare("DELETE FROM bans WHERE id = ?").bind(banId).run();
  await env.KV.delete("banned_keys_cache");
  return json({ removed: true });
}

// GET /api/ban?target_type=user&target_id=xxx — check ban status
export async function checkBan(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const targetType = url.searchParams.get("target_type");
  const targetId = url.searchParams.get("target_id");

  if (!targetType || !targetId) return json({ error: "target_type and target_id required" }, 400);

  const now = Math.floor(Date.now() / 1000);
  const ban = await env.DB
    .prepare(
      `SELECT * FROM bans WHERE target_type = ? AND target_id = ?
       AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1`
    )
    .bind(targetType, targetId, now)
    .first();

  return json({ banned: !!ban, ban });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
