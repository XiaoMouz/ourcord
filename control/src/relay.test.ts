import { describe, it, expect, vi } from "vitest";
import {
  registerRelay,
  getRelayMap,
  getBannedKeys,
  denyPeerOnRelay,
  allowPeerOnRelay,
} from "./relay";
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

async function makeToken(sub = "u1"): Promise<string> {
  const data = b64url(JSON.stringify({ sub, email: `${sub}@x.io`, iat: 1, exp: 9999999999 }));
  return `${data}.${await hmacSign(SECRET, data)}`;
}

type DBStep = { first?: unknown; run?: unknown; all?: unknown };

interface CapturingDB {
  db: D1Database;
  binds: unknown[][];
  sqls: string[];
}

// Scripted D1 mock: each prepare() call pops the next step from the plan and
// records both the SQL text and the bound arguments. The handlers under test
// always issue a deterministic sequence of prepare() calls so this is enough
// to assert ordering and parameters without a real DB.
function makeDB(plan: DBStep[]): CapturingDB {
  let i = 0;
  const binds: unknown[][] = [];
  const sqls: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const idx = i++;
      sqls.push(sql);
      const step = () => plan[idx] || {};
      const s: any = {
        bind: vi.fn((...args: unknown[]) => {
          binds[idx] = args;
          return s;
        }),
        first: vi.fn(async () => step().first ?? null),
        run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
        all: vi.fn(async () => step().all ?? { results: [] }),
      };
      return s as D1PreparedStatement;
    }),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
  return { db, binds, sqls };
}

function makeEnv(db: D1Database, extra: Partial<Env> = {}): Env {
  return {
    DB: db,
    KV: {} as KVNamespace,
    SIGNAL: {} as DurableObjectNamespace,
    ENVIRONMENT: "production",
    JWT_SECRET: SECRET,
    ...extra,
  } as Env;
}

async function postRegister(token: string | null, body: unknown): Promise<Request> {
  const j = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(j.length),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://control.example/api/relay/register", {
    method: "POST",
    headers,
    body: j,
  });
}

describe("registerRelay (POST /api/relay/register)", () => {
  it("missing Authorization → 401", async () => {
    const env = makeEnv(makeDB([]).db);
    const resp = await registerRelay(
      await postRegister(null, { hostname: "h", region: "us", mode: "personal" }),
      env,
    );
    expect(resp.status).toBe(401);
  });

  it("personal mode: happy path inserts relay row and returns 201 with id", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null }, // ban check
      {}, // INSERT
      { first: { id: "canonical-relay-id" } }, // SELECT canonical id
    ]);
    const env = makeEnv(cap.db);
    const resp = await registerRelay(
      await postRegister(token, {
        hostname: "relay.example",
        region: "us-east",
        mode: "personal",
        port: 4443,
        capacity_kbps: 5000,
      }),
      env,
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{ id: string }>();
    expect(body.id).toBe("canonical-relay-id");
    // INSERT bind (call index 1): id, owner_id, region, hostname, port, mode, capacity, registered_at, last_heartbeat
    expect(cap.binds[1][1]).toBe("alice");
    expect(cap.binds[1][2]).toBe("us-east");
    expect(cap.binds[1][3]).toBe("relay.example");
    expect(cap.binds[1][4]).toBe(4443);
    expect(cap.binds[1][5]).toBe("personal");
    expect(cap.binds[1][6]).toBe(5000);
    expect(cap.sqls[1]).toMatch(/INSERT INTO relay_servers/);
  });

  it("personal mode: defaults port=443 and capacity_kbps=10000 when omitted", async () => {
    const token = await makeToken();
    const cap = makeDB([
      { first: null },
      {},
      { first: { id: "rid" } },
    ]);
    const resp = await registerRelay(
      await postRegister(token, { hostname: "r", region: "eu", mode: "personal" }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(201);
    expect(cap.binds[1][4]).toBe(443);
    expect(cap.binds[1][6]).toBe(10000);
  });

  it("lobby mode without admin allowlist → 403 (requireAdmin)", async () => {
    const token = await makeToken("u1");
    const env = makeEnv(makeDB([{ first: null }]).db); // ban check then admin gate fails
    const resp = await registerRelay(
      await postRegister(token, { hostname: "h", region: "us", mode: "lobby" }),
      env,
    );
    expect(resp.status).toBe(403);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/admin/i);
  });

  it("lobby mode with admin allowlist matching caller → inserts and 201", async () => {
    const token = await makeToken("admin1");
    const cap = makeDB([
      { first: null }, // ban check
      {}, // INSERT
      { first: { id: "lobby-rid" } },
    ]);
    const env = makeEnv(cap.db, { ADMIN_USER_IDS: "admin1,admin2" });
    const resp = await registerRelay(
      await postRegister(token, { hostname: "h", region: "us", mode: "lobby" }),
      env,
    );
    expect(resp.status).toBe(201);
    expect(cap.binds[1][5]).toBe("lobby");
  });

  it("rental mode without admin → 403", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([{ first: null }]).db);
    const resp = await registerRelay(
      await postRegister(token, { hostname: "h", region: "us", mode: "rental" }),
      env,
    );
    expect(resp.status).toBe(403);
  });

  it("missing hostname → 400", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([{ first: null }]).db);
    const resp = await registerRelay(
      await postRegister(token, { region: "us", mode: "personal" }),
      env,
    );
    expect(resp.status).toBe(400);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/hostname/);
  });

  it("oversized body → 413 before auth", async () => {
    const j = JSON.stringify({ hostname: "h", region: "us", mode: "personal" });
    const req = new Request("https://control.example/api/relay/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(5 * 1024),
        Authorization: "Bearer whatever",
      },
      body: j,
    });
    const resp = await registerRelay(req, makeEnv(makeDB([]).db));
    expect(resp.status).toBe(413);
  });

  it("heartbeat (id present): updates last_heartbeat + load row, returns updated:true", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null }, // ban check
      { first: { id: "r1", owner_id: "alice" } }, // existing relay
      {}, // UPDATE relay_servers
      {}, // INSERT relay_load
    ]);
    const env = makeEnv(cap.db);
    const resp = await registerRelay(
      await postRegister(token, {
        id: "r1",
        hostname: "h",
        region: "us",
        mode: "personal",
        capacity_kbps: 8000,
        active_conns: 12,
        bytes_per_sec: 9000,
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ id: string; updated: boolean }>();
    expect(body).toEqual({ id: "r1", updated: true });
    expect(cap.sqls[2]).toMatch(/UPDATE relay_servers/);
    // UPDATE bind: now, region, mode, capacity, id
    expect(cap.binds[2][1]).toBe("us");
    expect(cap.binds[2][2]).toBe("personal");
    expect(cap.binds[2][3]).toBe(8000);
    expect(cap.binds[2][4]).toBe("r1");
    expect(cap.sqls[3]).toMatch(/relay_load/);
    expect(cap.binds[3][1]).toBe(12);
    expect(cap.binds[3][2]).toBe(9000);
  });

  it("heartbeat: unknown relay id → 404", async () => {
    const token = await makeToken();
    const cap = makeDB([
      { first: null }, // ban check
      { first: null }, // SELECT relay → not found
    ]);
    const resp = await registerRelay(
      await postRegister(token, {
        id: "ghost", hostname: "h", region: "us", mode: "personal",
      }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(404);
  });

  it("heartbeat: existing relay owned by another user → 403", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { first: { id: "r1", owner_id: "bob" } },
    ]);
    const resp = await registerRelay(
      await postRegister(token, {
        id: "r1", hostname: "h", region: "us", mode: "personal",
      }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(403);
  });

  it("heartbeat: omits load row when active_conns/bytes_per_sec absent", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { first: { id: "r1", owner_id: "alice" } },
      {}, // UPDATE only — no INSERT into relay_load expected
    ]);
    const resp = await registerRelay(
      await postRegister(token, {
        id: "r1", hostname: "h", region: "us", mode: "personal",
      }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(200);
    expect(cap.sqls).toHaveLength(3);
    expect(cap.sqls[2]).toMatch(/UPDATE relay_servers/);
  });
});

describe("getRelayMap (GET /api/relay/map)", () => {
  async function getReq(token: string | null, query = ""): Promise<Request> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request(`https://control.example/api/relay/map${query}`, { headers });
  }

  it("missing Authorization → 401", async () => {
    const env = makeEnv(makeDB([]).db);
    const resp = await getRelayMap(await getReq(null), env);
    expect(resp.status).toBe(401);
  });

  it("returns relays ranked by headroom; SQL filters stale + scopes personal to owner", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null }, // ban check
      {
        all: {
          results: [
            { id: "low", region: "us", hostname: "a", port: 443, mode: "lobby",
              capacity_kbps: 1000, active_conns: 5, bytes_per_sec: 100_000 },
            { id: "high", region: "us", hostname: "b", port: 443, mode: "lobby",
              capacity_kbps: 5000, active_conns: 1, bytes_per_sec: 1000 },
          ],
        },
      },
    ]);
    const env = makeEnv(cap.db);
    const resp = await getRelayMap(await getReq(token, "?region=us"), env);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ relays: Array<{ id: string; headroom_kbps: number }>; region: string }>();
    expect(body.region).toBe("us");
    expect(body.relays[0].id).toBe("high"); // highest headroom first
    expect(body.relays[1].id).toBe("low");
    expect(body.relays[0].headroom_kbps).toBeGreaterThan(body.relays[1].headroom_kbps);
    // SQL must filter stale heartbeats and scope personal relays.
    expect(cap.sqls[1]).toMatch(/last_heartbeat\s*>\s*\?/);
    expect(cap.sqls[1]).toMatch(/mode\s*<>\s*'personal'\s*OR\s*[a-z.]*owner_id\s*=\s*\?/);
    // bind: now-120, userId, region
    const b = cap.binds[1];
    expect(b[1]).toBe("alice");
    expect(b[2]).toBe("us");
  });

  it("no region: SQL omits region filter and bind has only freshness + userId", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { all: { results: [] } },
    ]);
    await getRelayMap(await getReq(token), makeEnv(cap.db));
    expect(cap.sqls[1]).not.toMatch(/r\.region\s*=\s*\?/);
    expect(cap.binds[1]).toHaveLength(2);
  });
});

describe("getBannedKeys (GET /api/relay/banned-keys)", () => {
  async function getReq(token: string | null, query = ""): Promise<Request> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request(`https://control.example/api/relay/banned-keys${query}`, { headers });
  }

  it("missing Authorization → 401", async () => {
    const env = makeEnv(makeDB([]).db);
    const resp = await getBannedKeys(await getReq(null), env);
    expect(resp.status).toBe(401);
  });

  it("returns deduped union of WG keys + DERP node keys; no relay_id → no per-relay query", async () => {
    const token = await makeToken();
    const cap = makeDB([
      { first: null }, // ban check
      {
        all: {
          results: [
            { public_key: "PK1", derp_node_key: "nodekey:aa" },
            { public_key: "PK2", derp_node_key: "" },
            { public_key: "PK1", derp_node_key: "nodekey:aa" }, // duplicate
          ],
        },
      },
    ]);
    const resp = await getBannedKeys(await getReq(token), makeEnv(cap.db));
    expect(resp.status).toBe(200);
    const body = await resp.json<{ keys: string[]; derp_keys: string[] }>();
    expect(body.keys.sort()).toEqual(["PK1", "PK2"]);
    expect(body.derp_keys).toEqual(["nodekey:aa"]);
    expect(cap.sqls).toHaveLength(2); // only ban-check + bans union
  });

  it("with ?relay_id=… merges per-relay denylist into keys", async () => {
    const token = await makeToken();
    const cap = makeDB([
      { first: null },
      { all: { results: [{ public_key: "GLOBAL1", derp_node_key: "" }] } },
      {
        all: {
          results: [
            { public_key: "DENY1", derp_node_key: "nodekey:dd" },
            { public_key: "GLOBAL1", derp_node_key: null }, // overlaps; still deduped
          ],
        },
      },
    ]);
    const resp = await getBannedKeys(await getReq(token, "?relay_id=r1"), makeEnv(cap.db));
    const body = await resp.json<{ keys: string[]; derp_keys: string[] }>();
    expect(body.keys.sort()).toEqual(["DENY1", "GLOBAL1"]);
    expect(body.derp_keys).toEqual(["nodekey:dd"]);
    expect(cap.binds[2][0]).toBe("r1");
  });
});

describe("denyPeerOnRelay (POST /api/relay/:id/deny)", () => {
  async function postDeny(token: string | null, body: unknown): Promise<Request> {
    const j = JSON.stringify(body);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(j.length),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request("https://control.example/api/relay/r1/deny", {
      method: "POST",
      headers,
      body: j,
    });
  }

  it("relay not found → 404", async () => {
    const token = await makeToken();
    const cap = makeDB([
      { first: null }, // ban check
      { first: null }, // SELECT relay → none
    ]);
    const resp = await denyPeerOnRelay(
      await postDeny(token, { public_key: "PK" }), makeEnv(cap.db), "r1",
    );
    expect(resp.status).toBe(404);
  });

  it("relay owned by someone else → 403", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { first: { owner_id: "bob" } },
    ]);
    const resp = await denyPeerOnRelay(
      await postDeny(token, { public_key: "PK" }), makeEnv(cap.db), "r1",
    );
    expect(resp.status).toBe(403);
  });

  it("missing public_key → 400", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { first: { owner_id: "alice" } },
    ]);
    const resp = await denyPeerOnRelay(
      await postDeny(token, {}), makeEnv(cap.db), "r1",
    );
    expect(resp.status).toBe(400);
  });

  it("happy path: inserts denylist row and returns denied:true", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { first: { owner_id: "alice" } },
      {}, // INSERT
    ]);
    const resp = await denyPeerOnRelay(
      await postDeny(token, { public_key: "PKxyz", reason: "abusive" }),
      makeEnv(cap.db), "r1",
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ denied: boolean }>();
    expect(body.denied).toBe(true);
    expect(cap.sqls[2]).toMatch(/INSERT INTO relay_denied_peers/);
    expect(cap.binds[2][0]).toBe("r1");
    expect(cap.binds[2][1]).toBe("PKxyz");
    expect(cap.binds[2][2]).toBe("abusive");
  });
});

describe("allowPeerOnRelay (DELETE /api/relay/:id/deny/:pk)", () => {
  async function delReq(token: string | null): Promise<Request> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return new Request("https://control.example/api/relay/r1/deny/PKxyz", {
      method: "DELETE",
      headers,
    });
  }

  it("foreign owner → 403, no DELETE issued", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { first: { owner_id: "bob" } },
    ]);
    const resp = await allowPeerOnRelay(await delReq(token), makeEnv(cap.db), "r1", "PKxyz");
    expect(resp.status).toBe(403);
    expect(cap.sqls).toHaveLength(2);
  });

  it("happy path: deletes row and returns removed:true", async () => {
    const token = await makeToken("alice");
    const cap = makeDB([
      { first: null },
      { first: { owner_id: "alice" } },
      {},
    ]);
    const resp = await allowPeerOnRelay(await delReq(token), makeEnv(cap.db), "r1", "PKxyz");
    expect(resp.status).toBe(200);
    const body = await resp.json<{ removed: boolean }>();
    expect(body.removed).toBe(true);
    expect(cap.sqls[2]).toMatch(/DELETE FROM relay_denied_peers/);
    expect(cap.binds[2]).toEqual(["r1", "PKxyz"]);
  });

  it("relay not found → 404", async () => {
    const token = await makeToken();
    const cap = makeDB([
      { first: null },
      { first: null },
    ]);
    const resp = await allowPeerOnRelay(await delReq(token), makeEnv(cap.db), "r1", "PKxyz");
    expect(resp.status).toBe(404);
  });
});
