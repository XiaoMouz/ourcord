import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { makeToken, signToken } from "./auth";
import type { Env } from "./types";

describe("active control status counts", () => {
  let db: DatabaseSync;
  let env: Env;
  let queries: number;
  let cache: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
  const now = 1_790_000_000;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    queries = 0;
    const snapshots = new Map<string, { response: Response; expires: number }>();
    cache = {
      match: vi.fn(async (request: Request) => {
        const cached = snapshots.get(request.url);
        return cached && cached.expires > Date.now() ? cached.response.clone() : undefined;
      }),
      put: vi.fn(async (request: Request, response: Response) => {
        const seconds = Number(response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 0);
        snapshots.set(request.url, { response: response.clone(), expires: Date.now() + seconds * 1000 });
      }),
    };
    vi.stubGlobal("caches", { default: cache });
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const migrations = join(__dirname, "../migrations");
    for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(migrations, file), "utf8"));
    }
    const prepare = (sql: string) => {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async first() {
          queries++;
          return db.prepare(sql).get(...params) ?? null;
        },
        async all() { return { results: db.prepare(sql).all(...params) }; },
      };
      return statement;
    };
    env = { ENVIRONMENT: "development", JWT_SECRET: "status-test-secret", ADMIN_USER_IDS: "operator",
      DB: { prepare } as unknown as D1Database } as Env;
    db.exec("INSERT INTO users(id,email,created_at) VALUES ('operator','operator@example.test',1)");
    const peer = db.prepare("INSERT INTO peers(id,user_id,public_key,ip4,ip6,last_seen) VALUES (?,'operator',?,?,?,?)");
    peer.run("recent", "recent", "198.19.0.1", "fd01::1", now - 299);
    peer.run("boundary", "boundary", "198.19.0.2", "fd01::2", now - 300);
    const relay = db.prepare("INSERT INTO relay_servers(id,owner_id,hostname,active,registered_at,last_heartbeat) VALUES (?,'operator',?,?,1,?)");
    relay.run("recent", "recent.test", 1, now - 119);
    relay.run("boundary", "boundary.test", 1, now - 120);
    relay.run("disabled", "disabled.test", 0, now);
    const ban = db.prepare("INSERT INTO bans(id,target_type,target_id,created_at,expires_at) VALUES (?,'peer',?,1,?)");
    ban.run("permanent", "unknown-1", null);
    ban.run("future", "unknown-2", now + 1);
    ban.run("boundary", "unknown-3", now);
  });
  afterEach(() => { db.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function call(path = "/api/control/status", headers: Record<string, string> = {}) {
    const pending: Promise<unknown>[] = [];
    const token = await signToken(makeToken("operator", "operator@example.test"), env.JWT_SECRET!);
    const response = await worker.fetch(new Request(`https://control.test${path}`, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    }), env, { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as ExecutionContext);
    await Promise.all(pending);
    return response;
  }
  async function counts(path: string) {
    const response = await call(path);
    expect(response.status).toBe(200);
    return (await response.json<{ counts: Record<string, number> }>()).counts;
  }

  it.each(["/api/control/status", "/api/control/fleet"])("keeps exact expiry boundaries for %s", async (path) => {
    expect(await counts(path)).toEqual({ users: 1, active_peers_5m: 1, active_relays: 1, active_bans: 2 });
  });

  it("shares a public snapshot across query strings and caller headers", async () => {
    const first = await call();
    const snapshot = await first.json();
    vi.advanceTimersByTime(1000);
    const second = await call("/api/control/status?random=123", { Authorization: "Bearer another-user", "Cache-Control": "no-cache" });
    expect(await second.json()).toEqual(snapshot);
    expect(second.headers.get("Cache-Control")).toBe("public, max-age=15");
    expect(second.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(queries).toBe(4);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("expires public snapshots while the authenticated fleet always remains fresh", async () => {
    db.prepare("UPDATE peers SET last_seen=? WHERE id='recent'").run(now);
    expect((await counts("/api/control/status")).active_peers_5m).toBe(1);
    db.prepare("UPDATE peers SET last_seen=? WHERE id='boundary'").run(now);
    expect((await counts("/api/control/status")).active_peers_5m).toBe(1);
    expect((await counts("/api/control/fleet")).active_peers_5m).toBe(2);
    vi.advanceTimersByTime(15_001);
    expect((await counts("/api/control/status")).active_peers_5m).toBe(2);
    expect(cache.put).toHaveBeenCalledTimes(2);
  });

  it("still applies the native rate gate before cache access", async () => {
    await call();
    env.ENVIRONMENT = "production";
    env.RATE_LIMIT_60 = { limit: vi.fn(async () => ({ success: false })) };
    expect((await call()).status).toBe(429);
    expect(cache.match).toHaveBeenCalledTimes(1);
    expect(queries).toBe(4);
  });

  it.each(["match", "put"] as const)("serves fresh counts when cache %s fails", async (operation) => {
    cache[operation].mockRejectedValue(new Error("cache unavailable"));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(queries).toBe(8);
  });

  it("does not cache database failures and recovers on the next request", async () => {
    const prepare = env.DB.prepare.bind(env.DB);
    const injected = vi.spyOn(env.DB, "prepare").mockImplementation(() => { throw new Error("injected count failure"); });
    expect((await call()).status).toBe(500);
    expect(cache.put).not.toHaveBeenCalled();
    injected.mockImplementation(prepare);
    expect((await call()).status).toBe(200);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  it("reflects heartbeat and expiry transitions without stale aggregate state", async () => {
    db.prepare("UPDATE peers SET last_seen=? WHERE id='boundary'").run(now);
    db.prepare("UPDATE relay_servers SET last_heartbeat=? WHERE id='boundary'").run(now);
    expect(await counts("/api/control/status")).toEqual({ users: 1, active_peers_5m: 2, active_relays: 2, active_bans: 2 });
    vi.setSystemTime((now + 301) * 1000);
    expect(await counts("/api/control/status")).toEqual({ users: 1, active_peers_5m: 0, active_relays: 0, active_bans: 1 });
  });
});
