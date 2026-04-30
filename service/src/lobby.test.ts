import { describe, it, expect, vi } from "vitest";
import { joinLobby } from "./lobby";
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
async function makeToken(): Promise<string> {
  const data = b64url(JSON.stringify({ sub: "u1", email: "u1@x.io", iat: 1, exp: 9999999999 }));
  return `${data}.${await hmacSign(SECRET, data)}`;
}

function makeDB(plan: { first?: unknown; run?: unknown }[]): D1Database {
  let i = 0;
  const stmt = () => {
    const idx = i++;
    const step = () => plan[idx] || {};
    const s: any = {
      bind: () => s,
      first: vi.fn(async () => step().first ?? null),
      run: vi.fn(async () => step().run ?? { meta: { changes: 0 } }),
      all: vi.fn(async () => ({ results: [] })),
    };
    return s as D1PreparedStatement;
  };
  return { prepare: vi.fn(() => stmt()), batch: vi.fn(), exec: vi.fn() } as unknown as D1Database;
}

async function joinReq(token: string, code: string | null): Promise<Request> {
  const url = code
    ? `https://service.example/api/lobbies/L1/join?code=${code}`
    : `https://service.example/api/lobbies/L1/join`;
  const body = JSON.stringify({});
  return new Request(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
}

describe("joinLobby", () => {
  it("rejects when no code provided", async () => {
    const token = await makeToken();
    const env = { ENVIRONMENT: "production", JWT_SECRET: SECRET, DB: makeDB([]) } as Env;
    const resp = await joinLobby(await joinReq(token, null), env, "L1");
    expect(resp.status).toBe(401);
  });

  it("returns 404 when lobby missing", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([{ first: null }]), // SELECT lobbies → null
    } as Env;
    const resp = await joinLobby(await joinReq(token, "ABC"), env, "L1");
    expect(resp.status).toBe(404);
  });

  it("short-circuits when already a member", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { id: "L1" } }, // lobby
        { first: { role: "member" } }, // membership
      ]),
    } as Env;
    const resp = await joinLobby(await joinReq(token, "ABC"), env, "L1");
    expect(resp.status).toBe(200);
    const body = await resp.json<{ message: string }>();
    expect(body.message).toMatch(/Already a member/);
  });

  it("rejects when invite update changes 0 rows (invalid/exhausted)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { id: "L1" } },
        { first: null }, // not yet a member
        { run: { meta: { changes: 0 } } }, // UPDATE invites → 0
      ]),
    } as Env;
    const resp = await joinLobby(await joinReq(token, "ABC"), env, "L1");
    expect(resp.status).toBe(403);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/invalid|revoked|exhausted/i);
  });

  it("happy path: invite consumed and membership inserted", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { id: "L1" } },
        { first: null },
        { run: { meta: { changes: 1 } } }, // UPDATE
        { run: { meta: { changes: 1 } } }, // INSERT OR IGNORE
      ]),
    } as Env;
    const resp = await joinLobby(await joinReq(token, "ABC"), env, "L1");
    expect(resp.status).toBe(200);
    const body = await resp.json<{ joined: boolean }>();
    expect(body.joined).toBe(true);
  });
});
