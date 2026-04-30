import { describe, it, expect } from "vitest";
import { constantTimeEqual, verifyToken, getJwtSecret } from "./auth";
import type { Env } from "./types";

const SECRET = "test-secret-1234567890abcdef";

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const b = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeToken(payload: object, secret = SECRET): Promise<string> {
  const data = b64url(JSON.stringify(payload));
  const sig = await hmacSign(secret, data);
  return `${data}.${sig}`;
}

describe("constantTimeEqual", () => {
  it("equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("different strings", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
  it("different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
  it("empty strings equal", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("verifyToken", () => {
  it("accepts valid token", async () => {
    const token = await makeToken({ sub: "u1", email: "u1@x.io", iat: 1, exp: 9999999999 });
    const r = await verifyToken(token, SECRET);
    expect(r).not.toBeNull();
    expect(r!.sub).toBe("u1");
  });
  it("rejects expired token", async () => {
    const token = await makeToken({ sub: "u1", email: "u1@x.io", iat: 1, exp: 1 });
    expect(await verifyToken(token, SECRET)).toBeNull();
  });
  it("rejects bad signature (different secret)", async () => {
    const token = await makeToken({ sub: "u1", email: "u1@x.io", iat: 1, exp: 9999999999 }, "other-secret");
    expect(await verifyToken(token, SECRET)).toBeNull();
  });
  it("rejects malformed token", async () => {
    expect(await verifyToken("garbage", SECRET)).toBeNull();
    expect(await verifyToken("a.b.c", SECRET)).toBeNull();
  });
});

describe("getJwtSecret", () => {
  it("returns env secret in production", () => {
    const env = { ENVIRONMENT: "production", JWT_SECRET: "x".repeat(32) } as Env;
    expect(getJwtSecret(env)).toBe("x".repeat(32));
  });
  it("throws in production when secret missing", () => {
    const env = { ENVIRONMENT: "production" } as Env;
    expect(() => getJwtSecret(env)).toThrow(/JWT_SECRET/);
  });
  it("throws in production when secret too short", () => {
    const env = { ENVIRONMENT: "production", JWT_SECRET: "short" } as Env;
    expect(() => getJwtSecret(env)).toThrow(/JWT_SECRET/);
  });
  it("dev fallback when missing", () => {
    const env = { ENVIRONMENT: "development" } as Env;
    expect(getJwtSecret(env)).toMatch(/dev-secret/);
  });
});
