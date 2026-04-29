// Lightweight auth middleware for service layer.
// Validates the same JWT format as control layer (shared JWT_SECRET).

import type { Env } from "./types";

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
    if (!env.JWT_SECRET) console.warn("[service/auth] JWT_SECRET unset; using dev fallback");
    return env.JWT_SECRET || "dev-secret-change-me-dev-only-not-for-prod";
  }
  throw new Error("JWT_SECRET is not configured (>=16 bytes required in production)");
}

// M4: see control/src/auth.ts for the rationale. Mirror here so service-layer
// handlers can guard their own JSON inputs without crossing module boundaries.
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
