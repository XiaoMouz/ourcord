// Device-level credentials (Phase 2).
//
// Problem: the daemon used to hold a raw 1-hour user JWT (env or state file),
// so every device of a user shared one credential that silently expired and
// could only be renewed by a human re-login. Here a device enrolls once while
// a fresh user JWT is at hand and receives a long-lived random secret bound to
// its WireGuard public key; the daemon then exchanges that secret for ordinary
// short-lived JWTs on its own schedule. Revoking one device deletes one row —
// no account-wide rotation, and bans are re-checked at every exchange so the
// 1-hour JWT TTL (X1) still bounds ban propagation.

import { Env } from "./types";
import {
  requireAuth,
  makeToken,
  signToken,
  getJwtSecret,
  generateId,
  checkBodySize,
  isUserBanned,
  json,
} from "./auth";
import { log } from "./log";

// Secrets are `dt_` + 32 random bytes base64url — recognizable in logs/tooling
// without being confusable with a JWT.
const DEVICE_TOKEN_PREFIX = "dt_";

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newDeviceSecret(): string {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const b64 = btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return DEVICE_TOKEN_PREFIX + b64;
}

// POST /api/devices/enroll — issue a device credential for one of the caller's
// devices. Requires a fresh user JWT (the human is present). Re-enrolling the
// same public key rotates the credential: the old secret stops working.
export async function enrollDevice(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  let body: { public_key?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const publicKey = typeof body.public_key === "string" ? body.public_key.trim() : "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(publicKey)) {
    return json({ error: "public_key must be base64-encoded 32-byte WireGuard key" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.slice(0, 64) : "";

  const secret = newDeviceSecret();
  const tokenHash = await sha256Hex(secret);
  const id = generateId();
  const now = Math.floor(Date.now() / 1000);

  // Rotation + insert as one atomic batch: at most one live credential per
  // (user, device key). D1 has no BEGIN/COMMIT; batch() is the atomic unit.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM device_tokens WHERE user_id = ? AND public_key = ?").bind(userId, publicKey),
    env.DB
      .prepare(
        "INSERT INTO device_tokens (id, user_id, public_key, token_hash, name, created_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(id, userId, publicKey, tokenHash, name, now),
  ]);

  log({ event: "devices.enrolled", user_id: userId, device_id: id });
  // The plaintext secret appears in this response only; it is never stored.
  return json({ id, device_token: secret, public_key: publicKey, name, created_at: now }, 201);
}

// POST /api/auth/device — exchange a device credential for a short-lived user
// JWT. Unauthenticated by design (this IS the authentication); rate-limited at
// the route. Bans are enforced here so a banned user's devices stop refreshing
// within one JWT TTL.
export async function exchangeDeviceToken(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;

  let body: { device_token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const secret = typeof body.device_token === "string" ? body.device_token.trim() : "";
  if (!secret.startsWith(DEVICE_TOKEN_PREFIX) || secret.length < 20 || secret.length > 128) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Hash-then-lookup: the DB never sees the plaintext, and an attacker with a
  // D1 dump holds only unusable hashes. Constant-time comparison is not needed
  // because the lookup key is already a fixed-length one-way hash.
  const tokenHash = await sha256Hex(secret);
  const row = await env.DB
    .prepare(
      `SELECT d.id, d.user_id, d.revoked_at, u.email
       FROM device_tokens d JOIN users u ON u.id = d.user_id
       WHERE d.token_hash = ?`,
    )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; revoked_at: number | null; email: string }>();
  if (!row || row.revoked_at) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (await isUserBanned(row.user_id, env.DB)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  // last_used is best-effort telemetry, not part of the auth decision — don't
  // block the JWT response on the write when the runtime can finish it after.
  const touch = env.DB.prepare("UPDATE device_tokens SET last_used = ? WHERE id = ?").bind(now, row.id).run();
  if (ctx) ctx.waitUntil(touch);
  else await touch;

  const payload = makeToken(row.user_id, row.email);
  const token = await signToken(payload, getJwtSecret(env));
  return json({ token, user_id: row.user_id, expires_at: payload.exp });
}

// GET /api/devices — list the caller's device credentials (metadata only).
export async function listDevices(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  const rows = await env.DB
    .prepare(
      `SELECT id, public_key, name, created_at, last_used, revoked_at
       FROM device_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all();
  return json({ devices: rows.results ?? [] });
}

// DELETE /api/devices/:id — revoke one device credential. Soft revoke keeps
// the row for auditability; exchange refuses revoked rows.
export async function revokeDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  const now = Math.floor(Date.now() / 1000);
  const device = await env.DB
    .prepare("SELECT public_key FROM device_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(deviceId, userId)
    .first<{ public_key: string }>();
  if (!device) {
    return json({ error: "device not found" }, 404);
  }
  // Revocation retires the network identity as well as its refresh secret.
  // Otherwise a revoked/offline device remains forever in room configs. Clear
  // topology rows explicitly because peer_connectivity predates peer FKs.
  await env.DB.batch([
    env.DB
      .prepare("UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .bind(now, deviceId, userId),
    env.DB
      // Enrollment may precede peer registration and is not proof of key
      // ownership. Only retire topology for a peer owned by this account.
      .prepare(`DELETE FROM peer_connectivity
        WHERE (src_public_key = ? OR dst_public_key = ?)
          AND EXISTS (SELECT 1 FROM peers WHERE public_key = ? AND user_id = ?)`)
      .bind(device.public_key, device.public_key, device.public_key, userId),
    env.DB
      .prepare("DELETE FROM peers WHERE user_id = ? AND public_key = ?")
      .bind(userId, device.public_key),
  ]);
  log({ event: "devices.revoked", user_id: userId, device_id: deviceId });
  return json({ ok: true });
}
