// Lightweight auth middleware for service layer.
// Validates the same JWT format as control layer (shared JWT_SECRET).

import type { Env } from "./types";
import { log } from "./log";

export interface TokenPayload {
  sub: string;
  email: string;
  iat: number;
  exp: number;
}

// H2: centralized JWT secret lookup. In production, missing/short secrets
// fail loud; in development a noisy fallback is allowed.
export function getJwtSecret(env: Env): string {
  if (env.JWT_SECRET && env.JWT_SECRET.length >= 16) return env.JWT_SECRET;
  if ((env.ENVIRONMENT ?? "development") === "development") {
    if (!env.JWT_SECRET) log({ event: "service_auth.jwt_secret_unset_dev_fallback", level: "warn" });
    return env.JWT_SECRET || "dev-secret-change-me-dev-only-not-for-prod";
  }
  throw new Error("JWT_SECRET is not configured (>=16 bytes required in production)");
}

// Mirror in control/src/auth.ts. Check actual bytes before JSON/form parsing;
// Content-Length is only a fast rejection path and may be absent on streams.
export async function checkBodySize(request: Request, maxBytes: number): Promise<Response | null> {
  const cl = request.headers.get("content-length");
  if (cl !== null && !/^\d+$/.test(cl)) {
    void request.body?.cancel().catch(() => {});
    return json({ error: "invalid content-length" }, 400);
  }
  if (cl !== null && Number(cl) > maxBytes) {
    void request.body?.cancel().catch(() => {});
    return json({ error: "request body too large" }, 413);
  }
  if (!request.body) return null;

  // The original branch retains only the bounded body for the existing parser.
  const reader = request.clone().body!.getReader();
  let size = 0;
  const cancel = () => {
    // Cancel both tee branches. Awaiting one alone can wait for the other;
    // an untrusted source's cancellation must not hold up the 413 response.
    void reader.cancel().catch(() => {});
    void request.body!.cancel().catch(() => {});
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return null;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        return json({ error: "request body too large" }, 413);
      }
    }
  } catch {
    cancel();
    return json({ error: "invalid request body" }, 400);
  } finally {
    reader.releaseLock();
  }
}

// Importing a CryptoKey is not free, and hmacSign runs on every JWT verify and
// every signed internal call with an effectively constant secret. Cache the
// imported key per secret (the Promise, so concurrent callers share one import).
const signKeyCache = new Map<string, Promise<CryptoKey>>();
function importSignKey(secret: string): Promise<CryptoKey> {
  let key = signKeyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    signKeyCache.set(secret, key);
  }
  return key;
}

// Exported for internalAuth.ts (G6 signed internal calls) — one HMAC/base64url
// implementation per worker so token verification and internal-call verification cannot drift.
export async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await importSignKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
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
  } catch { return null; }
}

export async function requireAuth(request: Request, secretOrEnv: string | Env): Promise<TokenPayload | Response> {
  const secret = typeof secretOrEnv === "string" ? secretOrEnv : getJwtSecret(secretOrEnv);
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return err("Unauthorized", 401);
  const payload = await verifyToken(auth.slice(7), secret);
  if (!payload) return err("Unauthorized", 401);
  return payload;
}

export function generateId(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function err(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
