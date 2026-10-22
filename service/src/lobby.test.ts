import { describe, it, expect, vi } from "vitest";
import { joinLobby, listLobbies, createRoom, updateRoom, deleteRoom } from "./lobby";
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

describe("listLobbies", () => {
  it("returns lobby navigation entries with ordered rooms", async () => {
    const token = await makeToken();
    const all = vi
      .fn()
      .mockResolvedValueOnce({ results: [{ id: "L1", name: "Friends", owner_id: "u1", icon: null, created_at: 1, role: "owner", joined_at: 2 }] })
      .mockResolvedValueOnce({ results: [{ id: "R1", lobby_id: "L1", name: "voice", type: "voice", position: 0, vpn_namespace: "vpn-1" }] });
    const db = {
      prepare: vi.fn(() => {
        const stmt: any = { bind: () => stmt, all };
        return stmt;
      }),
    } as unknown as D1Database;
    const env = { ENVIRONMENT: "production", JWT_SECRET: SECRET, DB: db } as Env;
    const req = new Request("https://service.example/api/lobbies", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const resp = await listLobbies(req, env);
    expect(resp.status).toBe(200);
    const body = await resp.json<any>();
    expect(body.lobbies[0].lobby.name).toBe("Friends");
    expect(body.lobbies[0].member.role).toBe("owner");
    expect(body.lobbies[0].rooms[0].vpn_namespace).toBe("vpn-1");
  });
});

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
  return {
    prepare: vi.fn(() => stmt()),
    batch: vi.fn(async (statements: D1PreparedStatement[]) => Promise.all(statements.map((s) => s.run()))),
    exec: vi.fn(),
  } as unknown as D1Database;
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

  it("rejects when the conditional membership insert changes 0 rows (invalid/exhausted)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { id: "L1" } },
        { first: null }, // not yet a member
        { run: { meta: { changes: 0 } } }, // conditional INSERT
        { run: { meta: { changes: 0 } } }, // no consumption
        { first: null }, // no concurrent membership
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
        { run: { meta: { changes: 1 } } }, // conditional INSERT
        { run: { meta: { changes: 1 } } }, // consume one use
      ]),
    } as Env;
    const resp = await joinLobby(await joinReq(token, "ABC"), env, "L1");
    expect(resp.status).toBe(200);
    const body = await resp.json<{ joined: boolean }>();
    expect(body.joined).toBe(true);
  });
});

function jsonReq(url: string, method: string, token: string, body: unknown): Request {
  const b = JSON.stringify(body);
  return new Request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(b.length),
    },
    body: b,
  });
}

function delReq(url: string, token: string): Request {
  return new Request(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("createRoom", () => {
  it("creates a text room with no vpn_namespace", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { role: "owner" } },        // membership
        { first: { m: 2 } },                  // MAX(position)
        { run: { meta: { changes: 1 } } },    // INSERT
      ]),
    } as Env;
    const req = jsonReq("https://x/api/lobbies/L1/rooms", "POST", token, { name: "chat", type: "text" });
    const resp = await createRoom(req, env, "L1");
    expect(resp.status).toBe(201);
    const b = await resp.json<{ name: string; type: string; position: number; vpn_namespace?: string }>();
    expect(b.name).toBe("chat");
    expect(b.type).toBe("text");
    expect(b.position).toBe(3);
    expect(b.vpn_namespace).toBeUndefined();
  });

  it("creates a voice room and auto-fills vpn_namespace", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { role: "admin" } },
        { first: { m: 0 } },
        { run: { meta: { changes: 1 } } },
      ]),
    } as Env;
    const req = jsonReq("https://x/api/lobbies/L1/rooms", "POST", token, { name: "huddle", type: "voice" });
    const resp = await createRoom(req, env, "L1");
    expect(resp.status).toBe(201);
    const b = await resp.json<{ vpn_namespace?: string; type: string }>();
    expect(b.type).toBe("voice");
    expect(b.vpn_namespace).toMatch(/^lobby-L1-.+-voice$/);
  });

  it("rejects when caller is a plain member (403)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([{ first: { role: "member" } }]),
    } as Env;
    const req = jsonReq("https://x/api/lobbies/L1/rooms", "POST", token, { name: "x", type: "text" });
    const resp = await createRoom(req, env, "L1");
    expect(resp.status).toBe(403);
  });

  it("rejects empty/invalid name (400)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([{ first: { role: "owner" } }]),
    } as Env;
    const req = jsonReq("https://x/api/lobbies/L1/rooms", "POST", token, { name: "   ", type: "text" });
    const resp = await createRoom(req, env, "L1");
    expect(resp.status).toBe(400);
  });

  it("rejects unknown type (400)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([{ first: { role: "owner" } }]),
    } as Env;
    const req = jsonReq("https://x/api/lobbies/L1/rooms", "POST", token, { name: "x", type: "stream" });
    const resp = await createRoom(req, env, "L1");
    expect(resp.status).toBe(400);
  });
});

describe("updateRoom", () => {
  it("renames a room (happy)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { id: "R1", lobby_id: "L1", name: "old", type: "text", position: 0 } },
        { first: { role: "admin" } },
        { first: { id: "R1", lobby_id: "L1", name: "new", type: "text", position: 0 } },
      ]),
    } as Env;
    const req = jsonReq("https://x/api/rooms/R1", "PATCH", token, { name: "new" });
    const resp = await updateRoom(req, env, "R1");
    expect(resp.status).toBe(200);
    const b = await resp.json<{ name: string; position: number }>();
    expect(b.name).toBe("new");
    expect(b.position).toBe(0);
  });

  it("rejects non-owner/admin (403)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { id: "R1", lobby_id: "L1", name: "old", type: "text", position: 0 } },
        { first: { role: "member" } },
      ]),
    } as Env;
    const req = jsonReq("https://x/api/rooms/R1", "PATCH", token, { name: "new" });
    const resp = await updateRoom(req, env, "R1");
    expect(resp.status).toBe(403);
  });
});

describe("deleteRoom", () => {
  it("deletes when owner and >1 rooms (happy)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L1" } },
        { first: { role: "owner" } },
        { run: { meta: { changes: 1 } } },
      ]),
    } as Env;
    const resp = await deleteRoom(delReq("https://x/api/rooms/R1", token), env, "R1");
    expect(resp.status).toBe(200);
    const b = await resp.json<{ deleted: boolean }>();
    expect(b.deleted).toBe(true);
  });

  it("admin cannot delete (403)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L1" } },
        { first: { role: "admin" } },
      ]),
    } as Env;
    const resp = await deleteRoom(delReq("https://x/api/rooms/R1", token), env, "R1");
    expect(resp.status).toBe(403);
  });

  it("refuses to delete the last remaining room (400)", async () => {
    const token = await makeToken();
    const env = {
      ENVIRONMENT: "production",
      JWT_SECRET: SECRET,
      DB: makeDB([
        { first: { lobby_id: "L1" } },
        { first: { role: "owner" } },
        { run: { meta: { changes: 0 } } },
      ]),
    } as Env;
    const resp = await deleteRoom(delReq("https://x/api/rooms/R1", token), env, "R1");
    expect(resp.status).toBe(400);
    const b = await resp.json<{ error: string }>();
    expect(b.error).toMatch(/at least one room/i);
  });
});
