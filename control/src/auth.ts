import { Env, User } from "./types";

// Simple JWT-like token using HMAC-SHA256
// Format: base64url(payload).base64url(signature)

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64url(str: string): string {
  // Encode as UTF-8 bytes then base64; avoids the deprecated unescape() path.
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin)
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + "=".repeat(padLen));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// constantTimeEqual compares two strings in time proportional to the length
// of the longer input, with no early termination. HMAC verification must
// avoid the JS `===` shortcut to neutralize timing side channels that would
// otherwise let an attacker recover the signature byte-by-byte.
// M4: enforce a Worker-side cap on request body size for handlers that read
// JSON. CF Workers default to a ~100 MB body cap, far larger than any legit
// JSON payload the control plane accepts. Returning 413 early on Content-Length
// avoids spending CPU/memory parsing attacker-chosen sizes.
//
// Note: Content-Length is advisory — chunked uploads can omit it. Workers in
// practice rejects chunked encoding from clients, so this header is reliable
// for the public Worker entrypoints. Defense-in-depth callers can still
// re-check string lengths after parse (already done on user-content fields).
export function checkBodySize(request: Request, maxBytes: number): Response | null {
  const cl = request.headers.get("content-length");
  if (cl === null) return null;
  const n = parseInt(cl, 10);
  if (!Number.isFinite(n) || n < 0) {
    return new Response(JSON.stringify({ error: "invalid content-length" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (n > maxBytes) {
    return new Response(JSON.stringify({ error: "request body too large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function constantTimeEqual(a: string, b: string): boolean {
  const al = a.length, bl = b.length;
  let diff = al ^ bl;
  const max = Math.max(al, bl);
  for (let i = 0; i < max; i++) {
    const ca = i < al ? a.charCodeAt(i) : 0;
    const cb = i < bl ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

export interface TokenPayload {
  sub: string; // user id
  email: string;
  iat: number;
  exp: number;
}

// X1: cap JWT lifetime at 1 hour. Bans are stored in D1 on the control plane
// only — the service worker can't see them directly. By forcing tokens to be
// refreshed via control every hour, we bound worst-case ban propagation to
// ~1h: at refresh time, requireAuth + the OTP/OAuth issuance paths consult
// isUserBanned and reject the user, after which their old token expires
// naturally on its own.
const TOKEN_TTL = 60 * 60; // 1 hour

export async function signToken(payload: TokenPayload, secret: string): Promise<string> {
  const data = b64url(JSON.stringify(payload));
  const sig = await hmacSign(secret, data);
  return `${data}.${sig}`;
}

export async function verifyToken(token: string, secret: string): Promise<TokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = await hmacSign(secret, data);
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const payload: TokenPayload = JSON.parse(b64urlDecode(data));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function makeToken(userId: string, email: string): TokenPayload {
  const now = Math.floor(Date.now() / 1000);
  return { sub: userId, email, iat: now, exp: now + TOKEN_TTL };
}

// getJwtSecret returns the configured JWT secret or throws if missing in
// production. Centralizing the lookup avoids the trap of multiple sites
// silently falling back to a known-weak default ("dev-secret-change-me")
// when an operator forgets to set the secret. In development the fallback
// is allowed but logged so it's noisy.
export function getJwtSecret(env: Env): string {
  if (env.JWT_SECRET && env.JWT_SECRET.length >= 16) return env.JWT_SECRET;
  if ((env.ENVIRONMENT ?? "development") === "development") {
    if (!env.JWT_SECRET) console.warn("[auth] JWT_SECRET unset; using dev fallback");
    return env.JWT_SECRET || "dev-secret-change-me-dev-only-not-for-prod";
  }
  throw new Error("JWT_SECRET is not configured (>=16 bytes required in production)");
}

// Extract and verify Bearer token from Authorization header
export async function authMiddleware(
  request: Request,
  env: Env
): Promise<TokenPayload | null> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return verifyToken(token, getJwtSecret(env));
}

// Require auth or return 401
export async function requireAuth(request: Request, env: Env): Promise<TokenPayload | Response> {
  const payload = await authMiddleware(request, env);
  if (!payload) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  // X1: enforce active user-bans even for tokens issued before the ban.
  // We deliberately respond with 401/Unauthorized (not 403/banned) so the
  // ban itself isn't disclosed to the holder of the now-revoked token; from
  // the client's perspective the credential is simply no longer valid and
  // the standard "re-authenticate" path applies — at which point the OTP
  // and OAuth issuers refuse the ban explicitly.
  if (await isUserBanned(payload.sub, env.DB)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return payload;
}

// Require auth + global-admin membership.
// ADMIN_USER_IDS is a comma-separated user-id allowlist on Env.
export async function requireAdmin(request: Request, env: Env): Promise<TokenPayload | Response> {
  const payload = await requireAuth(request, env);
  if (payload instanceof Response) return payload;
  const admins = (env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.includes(payload.sub)) {
    return new Response(JSON.stringify({ error: "Admin required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return payload;
}

// Check if user is banned
export async function isUserBanned(userId: string, db: D1Database): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const ban = await db
    .prepare(
      `SELECT id FROM bans WHERE target_type = 'user' AND target_id = ?
       AND (expires_at IS NULL OR expires_at > ?)`
    )
    .bind(userId, now)
    .first<{ id: string }>();
  return !!ban;
}

// Generate a cryptographically random 6-digit OTP.
//
// X2: rejection sampling removes the modulo bias that `% 1_000_000` on a
// Uint32 would otherwise introduce. 2^32 is not divisible by 1_000_000, so
// the last partial bucket (4_294_000_000 .. 4_294_967_295) over-represents
// codes 0..967_295 by ~0.0008%. Negligible cryptographically but easy to
// avoid: discard draws in that tail and try again.
export function generateOTP(): string {
  const arr = new Uint32Array(1);
  // Largest multiple of 1_000_000 that fits in Uint32 (4294 * 1_000_000).
  const limit = 4_294_000_000;
  do {
    crypto.getRandomValues(arr);
  } while (arr[0] >= limit);
  return String(arr[0] % 1_000_000).padStart(6, "0");
}

export function generateId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
