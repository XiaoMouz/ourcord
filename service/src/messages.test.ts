import { describe, it, expect, vi } from "vitest";
import { getMessages, sendMessage } from "./messages";
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

// Minimal D1 mock that lets us script .first()/.run() return values per call.
function makeDB(plan: { first?: unknown; run?: unknown }[]): D1Database {
  let i = 0;
  const stmt = () => {
    const idx = i++;
    const step = () => plan[idx] || {};
    const s: any = {
      bind: () => s,
      first: vi.fn(async () => step().first ?? null),
      run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
      all: vi.fn(async () => ({ results: [] })),
    };
    return s as D1PreparedStatement;
  };
  return {
    prepare: vi.fn(() => stmt()),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

async function postMessage(token: string, body: object): Promise<Request> {
  const json = JSON.stringify(body);
  return new Request("https://service.example/api/rooms/r1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(json.length),
    },
    body: json,
  });
}

describe("getMessages page bounds", () => {
  it.each(["-1", "0", "NaN", "1.5", "", "1e3", "3abc", "9007199254740992"])(
    "rejects invalid limit %j before querying message history", async (limit) => {
      const db = makeDB([{ first: { lobby_id: "L" } }, { first: { 1: 1 } }]);
      const env = { ENVIRONMENT: "production", JWT_SECRET: SECRET, DB: db } as Env;
      const url = new URL("https://service.example/api/rooms/r1/messages");
      url.searchParams.set("limit", limit);
      const request = new Request(url, {
        headers: { Authorization: `Bearer ${await makeToken()}` },
      });
      const response = await getMessages(request, env, "r1");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "limit must be a positive integer" });
      expect(db.prepare).toHaveBeenCalledTimes(2);
    },
  );
});

describe("sendMessage room.type gating", () => {
  it("allows text room", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L", type: "text" } }, // SELECT room
        { first: { 1: 1 } }, // SELECT membership
        { run: { meta: { changes: 1 } } }, // INSERT
      ]),
    } as Env;
    const resp = await sendMessage(await postMessage(token, { content: "hi" }), env, "r1");
    expect(resp.status).toBe(201);
  });

  it("allows voice room (text channel under voice room)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L", type: "voice" } },
        { first: { 1: 1 } },
        { run: { meta: { changes: 1 } } },
      ]),
    } as Env;
    const resp = await sendMessage(await postMessage(token, { content: "hi" }), env, "r1");
    expect(resp.status).toBe(201);
  });

  it("rejects file room with 400 (no text history for file rooms)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([{ first: { lobby_id: "L", type: "file" } }]),
    } as Env;
    const resp = await sendMessage(await postMessage(token, { content: "hi" }), env, "r1");
    expect(resp.status).toBe(400);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/does not support/i);
  });

  it("rejects video room", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([{ first: { lobby_id: "L", type: "video" } }]),
    } as Env;
    const resp = await sendMessage(await postMessage(token, { content: "hi" }), env, "r1");
    expect(resp.status).toBe(400);
  });

  it("404 when room missing", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([{ first: null }]),
    } as Env;
    const resp = await sendMessage(await postMessage(token, { content: "hi" }), env, "r1");
    expect(resp.status).toBe(404);
  });

  it("403 when not a lobby member", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L", type: "text" } },
        { first: null }, // membership lookup empty
      ]),
    } as Env;
    const resp = await sendMessage(await postMessage(token, { content: "hi" }), env, "r1");
    expect(resp.status).toBe(403);
  });

  it("rejects oversized content with 413", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L", type: "text" } },
        { first: { 1: 1 } },
      ]),
    } as Env;
    const big = "a".repeat(8 * 1024 + 1);
    const resp = await sendMessage(await postMessage(token, { content: big }), env, "r1");
    expect(resp.status).toBe(413);
  });

  it("rejects non-string content with 400", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L", type: "text" } },
        { first: { 1: 1 } },
      ]),
    } as Env;
    const resp = await sendMessage(await postMessage(token, { content: 123 }), env, "r1");
    expect(resp.status).toBe(400);
  });
});
