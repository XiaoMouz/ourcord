import { describe, it, expect, vi } from "vitest";
import { getPeerConfig, lookupPeers, registerPeer } from "./peers";
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

type DBStep = { first?: unknown; run?: unknown; all?: unknown };

// Scripted D1 mock: each prepare() call pops the next step from the plan.
// Supports first()/run()/all() returning whatever the step provides.
function makeDB(plan: DBStep[]): D1Database {
  let i = 0;
  const stmt = () => {
    const idx = i++;
    const step = () => plan[idx] || {};
    const s: any = {
      bind: () => s,
      first: vi.fn(async () => step().first ?? null),
      run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
      all: vi.fn(async () => step().all ?? { results: [] }),
    };
    return s as D1PreparedStatement;
  };
  return {
    prepare: vi.fn(() => stmt()),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    KV: {} as KVNamespace,
    SIGNAL: {} as DurableObjectNamespace,
    ENVIRONMENT: "production",
    JWT_SECRET: SECRET,
  } as Env;
}

interface CapturingDB {
  db: D1Database;
  binds: unknown[][];
  sqls: string[];
}

function makeCapturingDB(plan: DBStep[]): CapturingDB {
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

async function postLookup(token: string | null, body: unknown): Promise<Request> {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(json.length),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://control.example/api/peers/lookup", {
    method: "POST",
    headers,
    body: json,
  });
}

async function postRegister(token: string | null, body: unknown): Promise<Request> {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(json.length),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://control.example/api/peers/register", {
    method: "POST",
    headers,
    body: json,
  });
}

async function getConfig(token: string, publicKey: string): Promise<Request> {
  return new Request("https://control.example/api/peers/config", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Peer-Public-Key": publicKey,
    },
  });
}

const VALID_WG_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("registerPeer / getPeerConfig endpoint hints", () => {
  it("updates an existing peer's wg_endpoint during register", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { id: "peer-1", user_id: "u1" } }, // existing public key
      {}, // UPDATE peers
      {
        first: {
          id: "peer-1",
          user_id: "u1",
          public_key: VALID_WG_KEY,
          name: "vm-a",
          platform: "linux",
          last_seen: 1,
          ip4: "198.18.0.10",
          ip6: "fdab:cdef:123::a",
          derp_node_key: "",
          wg_endpoint: "192.168.139.235:51820",
        },
      },
    ]);
    const resp = await registerPeer(
      await postRegister(token, {
        public_key: VALID_WG_KEY,
        name: "vm-a",
        platform: "linux",
        wg_endpoint: "192.168.139.235:51820",
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/wg_endpoint = \?/);
    expect(cap.binds[2][4]).toBe("192.168.139.235:51820");
    const body = await resp.json<{ peer: { wg_endpoint: string } }>();
    expect(body.peer.wg_endpoint).toBe("192.168.139.235:51820");
  });

  it("rejects malformed wg_endpoint values", async () => {
    const token = await makeToken();
    const resp = await registerPeer(
      await postRegister(token, {
        public_key: VALID_WG_KEY,
        name: "vm-a",
        platform: "linux",
        wg_endpoint: "192.168.139.235 not-a-port",
      }),
      makeEnv(makeDB([{ first: null }])),
    );

    expect(resp.status).toBe(400);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/host:port/);
  });

  it("returns wg_endpoint as endpoint from peer config", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      {
        all: {
          results: [
            {
              id: "peer-2",
              user_id: "u1",
              public_key: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
              name: "vm-b",
              platform: "linux",
              last_seen: 2,
              ip4: "198.18.0.11",
              ip6: "fdab:cdef:123::b",
              derp_node_key: "nodekey:peer-b",
              endpoint: "192.168.139.110:51820",
            },
          ],
        },
      },
      { all: { results: [] } }, // relay map
    ]);
    const resp = await getPeerConfig(await getConfig(token, VALID_WG_KEY), makeEnv(cap.db));

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/wg_endpoint AS endpoint/);
    expect(cap.sqls[2]).toMatch(/derp_node_key/);
    const body = await resp.json<{ peers: Array<{ endpoint: string; derp_node_key: string }> }>();
    expect(body.peers[0].endpoint).toBe("192.168.139.110:51820");
    expect(body.peers[0].derp_node_key).toBe("nodekey:peer-b");
  });

  it("excludes the requesting public key from peer config", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      { all: { results: [] } },
      { all: { results: [] } }, // relay map
    ]);
    const resp = await getPeerConfig(await getConfig(token, VALID_WG_KEY), makeEnv(cap.db));

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/public_key <> \?/);
    expect(cap.binds[2]).toEqual(["u1", VALID_WG_KEY]);
  });
});

describe("lookupPeers", () => {
  it("happy path: 3 user_ids → result map keyed by user_id", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([
      { first: null }, // ban check
      {
        all: {
          results: [
            { user_id: "a", public_key: "PKa", ip4: "100.1.0.1", ip6: "fd::1", derp_node_key: "", last_seen: 1 },
            { user_id: "b", public_key: "PKb", ip4: "100.1.0.2", ip6: "fd::2", derp_node_key: "nodekey:xx", last_seen: 2 },
          ],
        },
      },
    ]));
    const resp = await lookupPeers(await postLookup(token, { user_ids: ["a", "b", "c"] }), env);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Record<string, unknown[]> }>();
    expect(Object.keys(body.peers).sort()).toEqual(["a", "b"]);
    expect(body.peers.a).toEqual([
      { public_key: "PKa", ip4: "100.1.0.1", ip6: "fd::1", derp_node_key: "", last_seen: 1 },
    ]);
    expect(body.peers.b[0]).toMatchObject({ public_key: "PKb", derp_node_key: "nodekey:xx" });
  });

  it("groups multiple peers under one user_id", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([
      { first: null },
      {
        all: {
          results: [
            { user_id: "a", public_key: "PK1", ip4: "100.1.0.1", ip6: "fd::1", derp_node_key: "", last_seen: 10 },
            { user_id: "a", public_key: "PK2", ip4: "100.1.0.2", ip6: "fd::2", derp_node_key: "", last_seen: 20 },
            { user_id: "a", public_key: "PK3", ip4: "100.1.0.3", ip6: "fd::3", derp_node_key: "", last_seen: 30 },
          ],
        },
      },
    ]));
    const resp = await lookupPeers(await postLookup(token, { user_ids: ["a"] }), env);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Record<string, unknown[]> }>();
    expect(Object.keys(body.peers)).toEqual(["a"]);
    expect(body.peers.a).toHaveLength(3);
  });

  it("user with no peers is omitted from result (not present as [])", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([
      { first: null },
      { all: { results: [] } },
    ]));
    const resp = await lookupPeers(await postLookup(token, { user_ids: ["ghost"] }), env);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Record<string, unknown[]> }>();
    expect(body.peers).toEqual({});
    expect("ghost" in body.peers).toBe(false);
  });

  it("empty array body → 400", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([{ first: null }]));
    const resp = await lookupPeers(await postLookup(token, { user_ids: [] }), env);
    expect(resp.status).toBe(400);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/non-empty/i);
  });

  it(">100 user_ids → 400 with 'too many' message", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([{ first: null }]));
    const ids = Array.from({ length: 101 }, (_, i) => `u${i}`);
    const resp = await lookupPeers(await postLookup(token, { user_ids: ids }), env);
    expect(resp.status).toBe(400);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/too many/i);
    expect(body.error).toMatch(/100/);
  });

  it("non-array body → 400", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([{ first: null }]));
    const resp = await lookupPeers(await postLookup(token, { user_ids: "not-an-array" }), env);
    expect(resp.status).toBe(400);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/array/i);
  });

  it("missing Authorization → 401", async () => {
    const env = makeEnv(makeDB([]));
    const resp = await lookupPeers(await postLookup(null, { user_ids: ["a"] }), env);
    expect(resp.status).toBe(401);
  });

  it("dedupes duplicate ids in body — single entry per user", async () => {
    const token = await makeToken();
    const captured: string[][] = [];
    let i = 0;
    const plan: DBStep[] = [
      { first: null },
      {
        all: {
          results: [
            { user_id: "a", public_key: "PKa", ip4: "100.1.0.1", ip6: "fd::1", derp_node_key: "", last_seen: 1 },
          ],
        },
      },
    ];
    const db = {
      prepare: vi.fn(() => {
        const idx = i++;
        const step = plan[idx] ?? {};
        const s: any = {
          bind: vi.fn((...args: string[]) => {
            captured.push(args);
            return s;
          }),
          first: vi.fn(async () => step.first ?? null),
          run: vi.fn(async () => step.run ?? { meta: { changes: 1 } }),
          all: vi.fn(async () => step.all ?? { results: [] }),
        };
        return s;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const env = makeEnv(db);
    const resp = await lookupPeers(
      await postLookup(token, { user_ids: ["a", "a", "a", "b", "b"] }),
      env,
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Record<string, unknown[]> }>();
    expect(body.peers.a).toHaveLength(1);
    // The bind() call for the SELECT (second prepare call, index 1) should
    // contain the deduped ids — exactly two, regardless of input multiplicity.
    const selectBind = captured[1];
    expect(selectBind.sort()).toEqual(["a", "b"]);
  });

  it("non-string entries in user_ids are skipped, not rejected", async () => {
    const token = await makeToken();
    const env = makeEnv(makeDB([
      { first: null },
      {
        all: {
          results: [
            { user_id: "a", public_key: "PKa", ip4: "100.1.0.1", ip6: "fd::1", derp_node_key: "", last_seen: 1 },
          ],
        },
      },
    ]));
    const resp = await lookupPeers(
      await postLookup(token, { user_ids: ["a", 42, null, { x: 1 }] as unknown[] }),
      env,
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Record<string, unknown[]> }>();
    expect(Object.keys(body.peers)).toEqual(["a"]);
  });
});
