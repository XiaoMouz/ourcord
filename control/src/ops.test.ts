import { describe, it, expect, vi } from "vitest";
import { getFleetStatus } from "./ops";
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

// Scripted D1 mock: prepare() pops the next step in call order. getFleetStatus
// issues a deterministic sequence: [ban check, relays.all, users, peers,
// relays-count, bans-count].
function makeDB(plan: DBStep[]): D1Database {
  let i = 0;
  return {
    prepare: vi.fn(() => {
      const idx = i++;
      const step = () => plan[idx] || {};
      const s: any = {
        bind: vi.fn(() => s),
        first: vi.fn(async () => step().first ?? null),
        run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
        all: vi.fn(async () => step().all ?? { results: [] }),
      };
      return s as D1PreparedStatement;
    }),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
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

function req(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://control.example/api/control/fleet", { method: "GET", headers });
}

// Standard step plan: ban-check clean, then relays, then the four counts.
function plan(relays: unknown[], counts = { users: 3, peers: 2, activeRelays: 1, bans: 0 }): DBStep[] {
  return [
    { first: null }, // isUserBanned
    { all: { results: relays } }, // relays.all
    { first: { c: counts.users } },
    { first: { c: counts.peers } },
    { first: { c: counts.activeRelays } },
    { first: { c: counts.bans } },
  ];
}

describe("getFleetStatus (GET /api/control/fleet)", () => {
  it("missing Authorization → 401", async () => {
    const resp = await getFleetStatus(req(null), makeEnv(makeDB([])));
    expect(resp.status).toBe(401);
  });

  it("valid token but not in ADMIN_USER_IDS → 403", async () => {
    const token = await makeToken("bob");
    const env = makeEnv(makeDB([{ first: null }]), { ADMIN_USER_IDS: "alice" });
    const resp = await getFleetStatus(req(token), env);
    expect(resp.status).toBe(403);
  });

  it("admin → 200 with relay detail, counts, and null backends when service unset", async () => {
    const now = Math.floor(Date.now() / 1000);
    const relays = [
      { id: "r1", region: "us", mode: "lobby", hostname: "a.example", port: 443, active: 1, capacity_kbps: 5000, last_heartbeat: now - 10, active_conns: 4, bytes_per_sec: 2048, reported_at: now - 10 },
      { id: "r2", region: "eu", mode: "personal", hostname: "b.example", port: 443, active: 1, capacity_kbps: 10000, last_heartbeat: now - 999, active_conns: 0, bytes_per_sec: 0, reported_at: 0 },
      { id: "r3", region: "hk", mode: "rental", hostname: "c.example", port: 443, active: 0, capacity_kbps: 10000, last_heartbeat: now - 5, active_conns: 0, bytes_per_sec: 0, reported_at: 0 },
    ];
    const env = makeEnv(makeDB(plan(relays)), { ADMIN_USER_IDS: "alice" });
    const resp = await getFleetStatus(req(await makeToken("alice")), env);
    expect(resp.status).toBe(200);
    const body = await resp.json<any>();

    expect(body.relays).toHaveLength(3);
    // r1: active + fresh heartbeat → healthy; load fields surfaced.
    expect(body.relays[0]).toMatchObject({ id: "r1", region: "us", active_conns: 4, bytes_per_sec: 2048, healthy: true });
    // r2: active but stale heartbeat (>120s) → unhealthy.
    expect(body.relays[1].healthy).toBe(false);
    // r3: fresh heartbeat but active=0 → unhealthy.
    expect(body.relays[2].healthy).toBe(false);

    expect(body.counts).toEqual({ users: 3, active_peers_5m: 2, active_relays: 1, active_bans: 0 });
    expect(body.backends).toBeNull();
    // Never leak owner attribution / keys on relay rows.
    expect(body.relays[0]).not.toHaveProperty("owner_id");
  });

  it("healthy boundary: heartbeat exactly at the 120s edge is not healthy", async () => {
    const now = Math.floor(Date.now() / 1000);
    // last_heartbeat === now-120 is NOT > now-120, so it must read unhealthy.
    const relays = [
      { id: "edge", region: "us", mode: "personal", hostname: "e.example", port: 443, active: 1, capacity_kbps: 10000, last_heartbeat: now - 120, active_conns: 0, bytes_per_sec: 0, reported_at: 0 },
    ];
    const env = makeEnv(makeDB(plan(relays)), { ADMIN_USER_IDS: "alice" });
    const resp = await getFleetStatus(req(await makeToken("alice")), env);
    const body = await resp.json<any>();
    expect(body.relays[0].healthy).toBe(false);
  });

  it("empty fleet → 200 with no relays", async () => {
    const env = makeEnv(makeDB(plan([])), { ADMIN_USER_IDS: "alice" });
    const resp = await getFleetStatus(req(await makeToken("alice")), env);
    expect(resp.status).toBe(200);
    const body = await resp.json<any>();
    expect(body.relays).toEqual([]);
  });
});
