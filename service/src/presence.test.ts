import { describe, expect, it, vi } from "vitest";
import { listMembers } from "./lobby";
import { leavePresence, updatePresence } from "./presence";
import type { Env } from "./types";

const SECRET = "test-secret-1234567890abcdef";

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(): Promise<string> {
  const data = b64url(JSON.stringify({ sub: "u1", email: "u1@example.com", iat: 1, exp: 9999999999 }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let binary = "";
  signature.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `${data}.${b64url(binary)}`;
}

type DBStep = { first?: unknown; all?: unknown[]; run?: unknown };

function mockDB(plan: DBStep[]) {
  let index = 0;
  const sql: string[] = [];
  const bindings: unknown[][] = [];
  const db = {
    prepare: vi.fn((query: string) => {
      const step = plan[index++] ?? {};
      sql.push(query);
      const stmt: any = {
        bind: (...values: unknown[]) => { bindings.push(values); return stmt; },
        first: vi.fn(async () => step.first ?? null),
        all: vi.fn(async () => ({ results: step.all ?? [] })),
        run: vi.fn(async () => step.run ?? { meta: { changes: 1 } }),
      };
      return stmt;
    }),
  } as unknown as D1Database;
  return { db, sql, bindings };
}

async function request(path: string, method = "POST", body?: unknown): Promise<Request> {
  const jwt = await token();
  return new Request(`https://service.example${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("lobby presence", () => {
  it("heartbeats all lobby memberships without exposing a device identity", async () => {
    const mock = mockDB([{}]);
    const env = { DB: mock.db, JWT_SECRET: SECRET, ENVIRONMENT: "production" } as Env;
    const response = await updatePresence(await request("/api/presence", "POST", {}), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ online: true, expires_in: 90 });
    expect(mock.sql[0]).toContain("INSERT INTO lobby_presence");
    expect(mock.sql[0]).toContain("FROM lobby_members");
    expect(mock.bindings[0].at(-1)).toBe("u1");
  });

  it("records a voice room only when the caller belongs to its lobby", async () => {
    const mock = mockDB([{ first: { lobby_id: "L1" } }, {}]);
    const env = { DB: mock.db, JWT_SECRET: SECRET, ENVIRONMENT: "production" } as Env;
    const response = await updatePresence(await request("/api/presence", "POST", { voice_room_id: "R1" }), env);

    expect(response.status).toBe(200);
    expect(mock.bindings[0]).toEqual(["R1", "u1"]);
    expect(mock.bindings[1].slice(1, 3)).toEqual(["L1", "R1"]);
  });

  it("rejects a voice room outside the caller's memberships", async () => {
    const mock = mockDB([{ first: null }]);
    const env = { DB: mock.db, JWT_SECRET: SECRET, ENVIRONMENT: "production" } as Env;
    const response = await updatePresence(await request("/api/presence", "POST", { voice_room_id: "private" }), env);
    expect(response.status).toBe(403);
  });

  it("retires all account presence immediately", async () => {
    const mock = mockDB([{}]);
    const env = { DB: mock.db, JWT_SECRET: SECRET, ENVIRONMENT: "production" } as Env;
    const response = await leavePresence(await request("/api/presence", "DELETE"), env);
    expect(response.status).toBe(200);
    expect(mock.sql[0]).toContain("DELETE FROM lobby_presence");
    expect(mock.bindings[0]).toEqual(["u1"]);
  });

  it("returns boolean online state and hides stale voice-room state", async () => {
    const mock = mockDB([
      { first: { role: "member" } },
      { all: [
        { lobby_id: "L1", user_id: "u1", role: "member", joined_at: 1, online: 1, voice_room_id: "R1" },
        { lobby_id: "L1", user_id: "u2", role: "member", joined_at: 2, online: 0, voice_room_id: "stale" },
      ] },
    ]);
    const env = { DB: mock.db, JWT_SECRET: SECRET, ENVIRONMENT: "production" } as Env;
    const response = await listMembers(await request("/api/lobbies/L1/members", "GET"), env, "L1");
    const body = await response.json<any>();

    expect(body.members[0]).toMatchObject({ user_id: "u1", online: true, voice_room_id: "R1" });
    expect(body.members[1]).toMatchObject({ user_id: "u2", online: false, voice_room_id: null });
  });
});

