import { checkBodySize, json, requireAuth } from "./auth";
import type { Env, User } from "./types";

const DISPLAY_NAME_MAX = 48;

export async function getMe(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const user = await env.DB.prepare(
    "SELECT id, email, display_name, created_at FROM users WHERE id = ?",
  ).bind(auth.sub).first<Pick<User, "id" | "email" | "display_name" | "created_at">>();
  if (!user) return json({ error: "User not found" }, 404);
  return json({ user });
}

export async function updateMe(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  let body: { display_name?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!displayName) return json({ error: "display_name required" }, 400);
  if (displayName.length > DISPLAY_NAME_MAX) {
    return json({ error: `display_name too long (max ${DISPLAY_NAME_MAX})` }, 413);
  }
  if (/[\x00-\x1f\x7f]/.test(displayName)) {
    return json({ error: "display_name contains control characters" }, 400);
  }
  await env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .bind(displayName, auth.sub).run();
  return json({ user: { id: auth.sub, email: auth.email, display_name: displayName } });
}

export async function lookupProfiles(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 8 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  let body: { user_ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!Array.isArray(body.user_ids) || body.user_ids.length > 90 ||
      body.user_ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) {
    return json({ error: "user_ids must contain at most 90 user ids" }, 400);
  }
  const ids = [...new Set(body.user_ids as string[])];
  if (ids.length === 0) return json({ profiles: [] });
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, display_name FROM users WHERE id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string; display_name: string }>();
  return json({ profiles: rows.results ?? [] });
}
