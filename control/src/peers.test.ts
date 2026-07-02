import { describe, it, expect, vi } from "vitest";
import { getPeerConfig, lookupPeers, registerPeer, reportPeerConnectivity } from "./peers";
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
const OTHER_WG_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const THIRD_WG_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
const PAIR_ROOM = "pair:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

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

  it("returns caller-visible personal relays alongside peer config for mixed user-relay + P2P", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      {
        all: {
          results: [
            {
              id: "peer-b",
              user_id: "u1",
              public_key: OTHER_WG_KEY,
              name: "friend",
              platform: "linux",
              last_seen: 42,
              ip4: "198.18.0.12",
              ip6: "fdab:cdef:123::b",
              derp_node_key: "nodekey:b",
              endpoint: "",
            },
          ],
        },
      },
      {
        all: {
          results: [
            {
              id: "personal-r1",
              region: "home",
              hostname: "relay.home.example",
              port: 443,
              mode: "personal",
              capacity_kbps: 5000,
              active_conns: 0,
              bytes_per_sec: 0,
            },
          ],
        },
      },
    ]);

    const resp = await getPeerConfig(await getConfig(token, VALID_WG_KEY), makeEnv(cap.db));

    expect(resp.status).toBe(200);
    expect(cap.sqls[3]).toMatch(/mode <> 'personal' OR r\.owner_id = \?/);
    expect(cap.binds[3][1]).toBe("u1");
    const body = await resp.json<{
      peers: Array<{ public_key: string }>;
      relays: Array<{ id: string; mode: string; hostname: string }>;
    }>();
    expect(body.peers[0].public_key).toBe(OTHER_WG_KEY);
    expect(body.relays[0]).toMatchObject({
      id: "personal-r1",
      mode: "personal",
      hostname: "relay.home.example",
    });
  });

  it("pair room config is scoped by exact peer public keys", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      {
        all: {
          results: [
            {
              id: "peer-b",
              user_id: "u2",
              public_key: OTHER_WG_KEY,
              name: "friend-phone",
              platform: "linux",
              last_seen: 42,
              ip4: "198.18.0.12",
              ip6: "fdab:cdef:123::c",
              derp_node_key: "nodekey:friend",
              endpoint: "",
            },
          ],
        },
      },
      { all: { results: [] } }, // relay map
    ]);
    const req = new Request(`https://control.example/api/peers/config?room_id=${encodeURIComponent(PAIR_ROOM)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Peer-Public-Key": VALID_WG_KEY,
      },
    });
    const resp = await getPeerConfig(req, makeEnv(cap.db));

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/public_key IN/);
    expect(cap.binds[2]).toEqual([VALID_WG_KEY, OTHER_WG_KEY, VALID_WG_KEY]);
    const body = await resp.json<{ peers: Array<{ public_key: string; user_id: string }> }>();
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0]).toMatchObject({ public_key: OTHER_WG_KEY, user_id: "u2" });
  });

  it("rejects pair room config when requester public key is not in the pair", async () => {
    const token = await makeToken();
    const resp = await getPeerConfig(
      new Request(`https://control.example/api/peers/config?room_id=${encodeURIComponent(PAIR_ROOM)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        },
      }),
      makeEnv(makeDB([{ first: null }, {}])),
    );

    expect(resp.status).toBe(403);
  });

  it("annotates one-hop next_hop_public_key from DERP-backed bottom edges when the direct edge is missing", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      {
        all: {
          results: [
            {
              id: "peer-b",
              user_id: "u2",
              public_key: OTHER_WG_KEY,
              name: "relay-hop",
              platform: "linux",
              last_seen: 30,
              ip4: "198.18.0.12",
              ip6: "fdab:cdef:123::b",
              derp_node_key: "nodekey:b",
              endpoint: "",
            },
            {
              id: "peer-c",
              user_id: "u3",
              public_key: THIRD_WG_KEY,
              name: "behind-hop",
              platform: "linux",
              last_seen: 20,
              ip4: "198.18.0.13",
              ip6: "fdab:cdef:123::c",
              derp_node_key: "nodekey:c",
              endpoint: "",
            },
          ],
        },
      },
      {
        all: {
          results: [
            { src_public_key: VALID_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: VALID_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: THIRD_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: THIRD_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
          ],
        },
      },
      { all: { results: [] } }, // relay map
    ]);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user_ids: ["u1", "u2", "u3"] })));
    vi.stubGlobal("fetch", fetchMock);

    const env = {
      ...makeEnv(cap.db),
      SERVICE_URL: "https://service.example",
      SERVICE_INTERNAL_TOKEN: "s2s",
    };
    const req = new Request("https://control.example/api/peers/config?room_id=lobby-L-room-R-voice", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Peer-Public-Key": VALID_WG_KEY,
      },
    });
    const resp = await getPeerConfig(req, env);

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    // G6: internal call must carry signed short-lived headers, not a bearer.
    const fetchArgs = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    const fetchHeaders = fetchArgs[1].headers;
    expect(fetchHeaders["X-Internal-Ts"]).toMatch(/^\d+$/);
    expect(fetchHeaders["X-Internal-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(fetchHeaders["X-Internal-Sig"]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fetchHeaders["X-Internal-Token"]).toBeUndefined();
    expect(cap.sqls[3]).toMatch(/peer_connectivity/);
    expect(cap.sqls[3]).toMatch(/wg_reachable = 1/);
    const body = await resp.json<{ peers: Array<{ public_key: string; next_hop_public_key?: string }> }>();
    const hop = body.peers.find((p) => p.public_key === OTHER_WG_KEY);
    const behind = body.peers.find((p) => p.public_key === THIRD_WG_KEY);
    expect(hop?.next_hop_public_key).toBeUndefined();
    expect(behind?.next_hop_public_key).toBe(OTHER_WG_KEY);

    vi.unstubAllGlobals();
  });

  it("does not create arbitrary one-hop routes when every edge is DERP baseline", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      {
        all: {
          results: [
            {
              id: "peer-b",
              user_id: "u2",
              public_key: OTHER_WG_KEY,
              name: "derp-b",
              platform: "linux",
              last_seen: 30,
              ip4: "198.18.0.12",
              ip6: "fdab:cdef:123::b",
              derp_node_key: "nodekey:b",
              endpoint: "",
            },
            {
              id: "peer-c",
              user_id: "u3",
              public_key: THIRD_WG_KEY,
              name: "derp-c",
              platform: "linux",
              last_seen: 20,
              ip4: "198.18.0.13",
              ip6: "fdab:cdef:123::c",
              derp_node_key: "nodekey:c",
              endpoint: "",
            },
          ],
        },
      },
      {
        all: {
          results: [
            { src_public_key: VALID_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: VALID_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: VALID_WG_KEY, dst_public_key: THIRD_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: THIRD_WG_KEY, dst_public_key: VALID_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: THIRD_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: THIRD_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
          ],
        },
      },
      { all: { results: [] } }, // relay map
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user_ids: ["u1", "u2", "u3"] }))));

    const resp = await getPeerConfig(
      new Request("https://control.example/api/peers/config?room_id=lobby-L-room-R-voice", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
        },
      }),
      {
        ...makeEnv(cap.db),
        SERVICE_URL: "https://service.example",
        SERVICE_INTERNAL_TOKEN: "s2s",
      },
    );

    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Array<{ next_hop_public_key?: string }> }>();
    expect(body.peers.every((p) => p.next_hop_public_key === undefined)).toBe(true);

    vi.unstubAllGlobals();
  });

  it("prefers a lower-cost ICE relay path over direct DERP fallback", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      {
        all: {
          results: [
            {
              id: "peer-b",
              user_id: "u2",
              public_key: OTHER_WG_KEY,
              name: "relay-hop",
              platform: "linux",
              last_seen: 30,
              ip4: "198.18.0.12",
              ip6: "fdab:cdef:123::b",
              derp_node_key: "nodekey:b",
              endpoint: "",
            },
            {
              id: "peer-c",
              user_id: "u3",
              public_key: THIRD_WG_KEY,
              name: "behind-hop",
              platform: "linux",
              last_seen: 20,
              ip4: "198.18.0.13",
              ip6: "fdab:cdef:123::c",
              derp_node_key: "nodekey:c",
              endpoint: "",
            },
          ],
        },
      },
      {
        all: {
          results: [
            { src_public_key: VALID_WG_KEY, dst_public_key: THIRD_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: THIRD_WG_KEY, dst_public_key: VALID_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: VALID_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 1, wg_reachable: 1, reason: "ice-validated" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: VALID_WG_KEY, ice_direct: 1, wg_reachable: 1, reason: "ice-validated" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: THIRD_WG_KEY, ice_direct: 1, wg_reachable: 1, reason: "ice-validated" },
            { src_public_key: THIRD_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 1, wg_reachable: 1, reason: "ice-validated" },
          ],
        },
      },
      { all: { results: [] } }, // relay map
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user_ids: ["u1", "u2", "u3"] }))));

    const resp = await getPeerConfig(
      new Request("https://control.example/api/peers/config?room_id=lobby-L-room-R-voice", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
        },
      }),
      {
        ...makeEnv(cap.db),
        SERVICE_URL: "https://service.example",
        SERVICE_INTERNAL_TOKEN: "s2s",
      },
    );

    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Array<{ public_key: string; next_hop_public_key?: string }> }>();
    const behind = body.peers.find((p) => p.public_key === THIRD_WG_KEY);
    expect(behind?.next_hop_public_key).toBe(OTHER_WG_KEY);

    vi.unstubAllGlobals();
  });

  it("routes via a next hop when the direct edge is unreachable (absent from wg_reachable rows)", async () => {
    // The daemon reported A-C wg_reachable=false, so the A-C/C-A edges are
    // filtered out by the WHERE wg_reachable=1 query. A-B and B-C survive (even
    // as plain DERP), so C must be reached via B — the A-B-C auto-discovery case.
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      {
        all: {
          results: [
            {
              id: "peer-b",
              user_id: "u2",
              public_key: OTHER_WG_KEY,
              name: "reachable-hop",
              platform: "linux",
              last_seen: 30,
              ip4: "198.18.0.12",
              ip6: "fdab:cdef:123::b",
              derp_node_key: "nodekey:b",
              endpoint: "",
            },
            {
              id: "peer-c",
              user_id: "u3",
              public_key: THIRD_WG_KEY,
              name: "unreachable-direct",
              platform: "linux",
              last_seen: 20,
              ip4: "198.18.0.13",
              ip6: "fdab:cdef:123::c",
              derp_node_key: "nodekey:c",
              endpoint: "",
            },
          ],
        },
      },
      {
        all: {
          // A-C / C-A intentionally absent: reported wg_reachable=false → filtered.
          results: [
            { src_public_key: VALID_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: VALID_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: OTHER_WG_KEY, dst_public_key: THIRD_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
            { src_public_key: THIRD_WG_KEY, dst_public_key: OTHER_WG_KEY, ice_direct: 0, wg_reachable: 1, reason: "derp-baseline" },
          ],
        },
      },
      { all: { results: [] } }, // relay map
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user_ids: ["u1", "u2", "u3"] }))));

    const resp = await getPeerConfig(
      new Request("https://control.example/api/peers/config?room_id=lobby-L-room-R-voice", {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
        },
      }),
      {
        ...makeEnv(cap.db),
        SERVICE_URL: "https://service.example",
        SERVICE_INTERNAL_TOKEN: "s2s",
      },
    );

    expect(resp.status).toBe(200);
    const body = await resp.json<{ peers: Array<{ public_key: string; next_hop_public_key?: string }> }>();
    const hop = body.peers.find((p) => p.public_key === OTHER_WG_KEY);
    const behind = body.peers.find((p) => p.public_key === THIRD_WG_KEY);
    expect(hop?.next_hop_public_key).toBeUndefined();
    expect(behind?.next_hop_public_key).toBe(OTHER_WG_KEY);

    vi.unstubAllGlobals();
  });

  it("chunks oversized member lists and skips topology annotation (G20)", async () => {
    const token = await makeToken();
    // 120 member ids → two IN() chunks; 60 returned peers → graphKeys 61 > 49
    // → annotateNextHops must bail instead of binding 2+2N params.
    const manyIds = Array.from({ length: 120 }, (_, i) => `u${i + 1}`);
    const rowFor = (n: number) => ({
      id: `p-${n}`,
      user_id: `u${n}`,
      public_key: `PK${n}`,
      name: `peer-${n}`,
      platform: "linux",
      last_seen: n,
      ip4: `198.18.1.${n}`,
      ip6: "",
      derp_node_key: "",
      endpoint: "",
    });
    const chunk1Rows = Array.from({ length: 60 }, (_, i) => rowFor(i + 1));
    const cap = makeCapturingDB([
      { first: null }, // ban check
      {}, // last_seen update
      { all: { results: chunk1Rows } }, // member chunk 1 (90 ids)
      { all: { results: [] } }, // member chunk 2 (30 ids)
      { all: { results: [] } }, // relay map (annotation skipped)
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user_ids: manyIds }))));

    const resp = await getPeerConfig(
      new Request("https://control.example/api/peers/config?room_id=lobby-L-room-R-voice", {
        headers: { Authorization: `Bearer ${token}`, "X-Peer-Public-Key": VALID_WG_KEY },
      }),
      { ...makeEnv(cap.db), SERVICE_URL: "https://service.example", SERVICE_INTERNAL_TOKEN: "s2s" },
    );

    expect(resp.status).toBe(200);
    // Each chunk stays within the D1 parameter budget (chunk + self filter).
    expect(cap.sqls[2]).toMatch(/user_id IN \((\?,){89}\?\)/);
    expect(cap.sqls[3]).toMatch(/user_id IN \((\?,){29}\?\)/);
    expect(cap.binds[2]).toHaveLength(91);
    expect(cap.binds[3]).toHaveLength(31);
    // The double-bound peer_connectivity query must not run at this size.
    expect(cap.sqls.some((s) => /peer_connectivity/.test(s))).toBe(false);
    const body = await resp.json<{ peers: Array<{ user_id: string }> }>();
    expect(body.peers).toHaveLength(60);
    // Merged output re-sorted by last_seen DESC across chunks.
    expect(body.peers[0].user_id).toBe("u60");

    vi.unstubAllGlobals();
  });
});

describe("reportPeerConnectivity", () => {
  it("mirrors direct connectivity observations", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { 1: 1 } }, // owned peer
      {}, // forward upsert
      {}, // reverse upsert
    ]);
    const body = JSON.stringify({
      network_id: "lobby-L-room-R-voice",
      peer_public_key: OTHER_WG_KEY,
      ice_direct: true,
      wg_reachable: true,
      rtt_ms: 12.7,
    });
    const resp = await reportPeerConnectivity(
      new Request("https://control.example/api/peers/connectivity", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/INSERT INTO peer_connectivity/);
    expect(cap.sqls[3]).toMatch(/INSERT INTO peer_connectivity/);
    expect(cap.binds[2].slice(0, 6)).toEqual(["lobby-L-room-R-voice", VALID_WG_KEY, OTHER_WG_KEY, 1, 1, 1]);
    expect(cap.binds[3].slice(0, 6)).toEqual(["lobby-L-room-R-voice", OTHER_WG_KEY, VALID_WG_KEY, 1, 1, 1]);
    expect(cap.binds[2][6]).toBe("ice");
    expect(cap.binds[3][6]).toBe("ice");
  });

  it("keeps WG-reachable edges when ICE direct degrades to DERP", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { 1: 1 } }, // owned peer
      {}, // forward delete
      {}, // reverse delete
    ]);
    const body = JSON.stringify({
      network_id: "lobby-L-room-R-voice",
      peer_public_key: OTHER_WG_KEY,
      ice_direct: false,
      wg_reachable: true,
      reason: "derp-fallback:direct-health-degraded",
    });
    const resp = await reportPeerConnectivity(
      new Request("https://control.example/api/peers/connectivity", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/INSERT INTO peer_connectivity/);
    expect(cap.sqls[3]).toMatch(/INSERT INTO peer_connectivity/);
    expect(cap.binds[2].slice(0, 6)).toEqual(["lobby-L-room-R-voice", VALID_WG_KEY, OTHER_WG_KEY, 0, 0, 1]);
    expect(cap.binds[3].slice(0, 6)).toEqual(["lobby-L-room-R-voice", OTHER_WG_KEY, VALID_WG_KEY, 0, 0, 1]);
    expect(cap.binds[2][6]).toBe("derp");
    expect(cap.binds[3][6]).toBe("derp");
  });

  it("does not let periodic DERP baseline overwrite an unreachable edge", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { 1: 1 } }, // owned peer
      {}, // forward upsert
      {}, // reverse upsert
    ]);
    const body = JSON.stringify({
      network_id: "lobby-L-room-R-voice",
      peer_public_key: OTHER_WG_KEY,
      ice_direct: false,
      wg_reachable: true,
      reason: "derp-baseline",
    });
    const resp = await reportPeerConnectivity(
      new Request("https://control.example/api/peers/connectivity", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/WHERE NOT \(/);
    expect(cap.sqls[2]).toMatch(/peer_connectivity\.reason = 'unreachable'/);
    expect(cap.sqls[2]).toMatch(/excluded\.reason = 'derp-baseline'/);
    expect(cap.binds[2].slice(0, 8)).toEqual(["lobby-L-room-R-voice", VALID_WG_KEY, OTHER_WG_KEY, 0, 0, 1, "derp", null]);
    expect(cap.binds[2][8]).toBe("derp-baseline");
  });

  it("allows reachability recovery reports to restore a previously unreachable DERP edge", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { 1: 1 } }, // owned peer
      {}, // forward upsert
      {}, // reverse upsert
    ]);
    const body = JSON.stringify({
      network_id: "lobby-L-room-R-voice",
      peer_public_key: OTHER_WG_KEY,
      ice_direct: false,
      wg_reachable: true,
      reason: "derp-recovery",
    });
    const resp = await reportPeerConnectivity(
      new Request("https://control.example/api/peers/connectivity", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(200);
    expect(cap.binds[2].slice(0, 8)).toEqual(["lobby-L-room-R-voice", VALID_WG_KEY, OTHER_WG_KEY, 0, 0, 1, "derp", null]);
    expect(cap.binds[2][8]).toBe("derp-recovery");
  });

  it("records a pair-network edge when both peers are pair members", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { 1: 1 } }, // owned peer
      {}, // forward upsert
      {}, // reverse upsert
    ]);
    const body = JSON.stringify({
      network_id: PAIR_ROOM,
      peer_public_key: OTHER_WG_KEY,
      ice_direct: true,
      wg_reachable: true,
    });
    const resp = await reportPeerConnectivity(
      new Request("https://control.example/api/peers/connectivity", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(200);
    expect(cap.sqls[2]).toMatch(/INSERT INTO peer_connectivity/);
    expect(cap.binds[2].slice(0, 3)).toEqual([PAIR_ROOM, VALID_WG_KEY, OTHER_WG_KEY]);
    expect(cap.binds[3].slice(0, 3)).toEqual([PAIR_ROOM, OTHER_WG_KEY, VALID_WG_KEY]);
  });

  it("rejects a pair report when the caller is not a pair member (403)", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { 1: 1 } }, // owned peer
    ]);
    const body = JSON.stringify({
      network_id: PAIR_ROOM,
      peer_public_key: THIRD_WG_KEY, // not one of the two pair members
      ice_direct: true,
      wg_reachable: true,
    });
    const resp = await reportPeerConnectivity(
      new Request("https://control.example/api/peers/connectivity", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(403);
    expect(cap.sqls.some((s) => /INSERT INTO peer_connectivity/.test(s))).toBe(false);
  });

  it("rejects a malformed pair network_id (400)", async () => {
    const token = await makeToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { first: { 1: 1 } }, // owned peer
    ]);
    const body = JSON.stringify({
      network_id: "pair:onlyone",
      peer_public_key: OTHER_WG_KEY,
      wg_reachable: true,
    });
    const resp = await reportPeerConnectivity(
      new Request("https://control.example/api/peers/connectivity", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Peer-Public-Key": VALID_WG_KEY,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
        body,
      }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(400);
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
