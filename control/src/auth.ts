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
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(str: string): string {
  return decodeURIComponent(escape(atob(str.replace(/-/g, "+").replace(/_/g, "/"))));
}

export interface TokenPayload {
  sub: string; // user id
  email: string;
  iat: number;
  exp: number;
}

const TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days

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
  if (sig !== expected) return null;
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

// Extract and verify Bearer token from Authorization header
export async function authMiddleware(
  request: Request,
  env: Env
): Promise<TokenPayload | null> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  return verifyToken(token, env.JWT_SECRET ?? "dev-secret-change-me");
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

// Generate a cryptographically random 6-digit OTP
export function generateOTP(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, "0");
}

export function generateId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
