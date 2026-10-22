import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { makeToken, signToken } from "./auth";
import type { Env } from "./types";

const key = (n: number) => btoa(String.fromCharCode(...Array(32).fill(n)));
const keys = [1, 2, 3, 4, 5].map(key);
const pair = (a: string, b: string) => `pair:${[a, b].map((k) => k.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")).sort().join(".")}`;

describe("connectivity write authority", () => {
  let db: DatabaseSync;
  let env: Env;
  let beforeUpsert: (() => void) | undefined;
  const now = 1_790_000_000;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(now * 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    beforeUpsert = undefined;
    db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
    const migrations = join(__dirname, "../migrations");
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(migrations, file), "utf8"));
    for (let i = 0; i < 4; i++) {
      db.prepare("INSERT INTO users(id,email,created_at) VALUES (?,?,1)").run(`u${i}`, `u${i}@example.test`);
      db.prepare("INSERT INTO peers(id,user_id,public_key,ip4,ip6,last_seen) VALUES (?,?,?,?,?,?)").run(`p${i}`, `u${i}`, keys[i], `198.19.0.${i + 1}`, `fd01::${i + 1}`, now);
    }
    env = { ENVIRONMENT: "development", JWT_SECRET: "connectivity-test-secret", SERVICE_URL: "https://service.test", SERVICE_INTERNAL_TOKEN: "local-service-secret",
      DB: { prepare(sql: string) {
        let params: unknown[] = [];
        const s = {
          bind(...values: unknown[]) { params = values; return s; },
          async first() { return db.prepare(sql).get(...params) ?? null; },
          async all() { return { results: db.prepare(sql).all(...params) }; },
          async run() {
            if (sql.includes("INSERT INTO peer_connectivity")) { const hook = beforeUpsert; beforeUpsert = undefined; hook?.(); }
            return { meta: db.prepare(sql).run(...params) };
          },
        }; return s;
      } },
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/rooms/room/member-ids")) return Response.json({ user_ids: ["u0", "u1", "u2"] });
      if (url.endsWith("/rooms/other/member-ids")) return Response.json({ user_ids: ["u3"] });
      return Response.json({ error: "Room not found" }, { status: 404 });
    }));
  });
  afterEach(() => { db.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function call(i: number, path: string, body?: Record<string, unknown>) {
    const token = await signToken(makeToken(`u${i}`, `u${i}@example.test`), env.JWT_SECRET!);
    return worker.fetch(new Request(`https://control.test${path}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "X-Peer-Public-Key": keys[i], "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env, {} as ExecutionContext);
  }
  const config = (i: number, room = "room") => call(i, `/api/peers/config?room_id=${encodeURIComponent(room)}`);
  const report = (i = 0, target = keys[1], network = "room", extra = {}) => call(i, "/api/peers/connectivity", { network_id: network, peer_public_key: target, ice_direct: true, wg_reachable: true, ...extra });
  const edges = () => db.prepare("SELECT * FROM peer_connectivity").all() as Array<Record<string, unknown>>;
  async function joinRoom() { for (const i of [0, 1, 2]) expect((await config(i)).status).toBe(200); }

  it("rejects nonexistent destination keys instead of growing D1", async () => {
    await joinRoom();
    const statuses = [];
    for (let i = 10; i < 30; i++) statuses.push((await report(0, key(i), `fake-${i}`)).status);
    expect({ statuses: [...new Set(statuses)], rows: edges().length }).toEqual({ statuses: [403], rows: 0 });
  });
  it("rejects registered peers in another network", async () => {
    await joinRoom(); await config(3, "other");
    expect((await report(0, keys[3])).status).toBe(403);
    expect(edges()).toHaveLength(0);
  });
  it("rejects network names the caller did not join", async () => {
    await joinRoom();
    expect((await report(0, keys[1], "invented")).status).toBe(403);
    expect(edges()).toHaveLength(0);
  });
  it.each([0, 1])("rejects reports after peer %i left or its lease expired", async (i) => {
    await joinRoom();
    db.prepare("UPDATE peer_presence SET last_seen=? WHERE public_key=?").run(now - 91, keys[i]);
    expect((await report()).status).toBe(403);
    expect(edges()).toHaveLength(0);
  });
  it("accepts the lease boundary and rejects reports after an explicit leave", async () => {
    await joinRoom();
    db.prepare("UPDATE peer_presence SET last_seen=?").run(now - 90);
    expect((await report()).status).toBe(200);
    expect((await call(1, "/api/peers/config")).status).toBe(200);
    expect((await report(0, keys[1], "room", { reporter_epoch: "new-epoch", seq: 1 })).status).toBe(403);
    expect(edges()[0].reporter_epoch).toBe("");
  });
  it.each(["unavailable", "missing", "unknown"])("does not publish a room lease when membership is %s", async (failure) => {
    if (failure === "unavailable") vi.mocked(fetch).mockRejectedValue(new Error("service unavailable"));
    if (failure === "missing") env.SERVICE_URL = undefined;
    expect((await config(0, "not-a-room")).status).toBe(200);
    expect(db.prepare("SELECT * FROM peer_presence").all()).toHaveLength(0);
  });
  it.each([{}, { user_ids: "u0" }, { user_ids: ["u0", 42] }])("does not grant a lease for malformed membership data %j", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body));
    expect((await config(0)).status).toBe(200);
    expect(db.prepare("SELECT * FROM peer_presence").all()).toHaveLength(0);
  });
  it("accepts authorized A-B-C edges and preserves sequence arbitration", async () => {
    await joinRoom();
    expect((await report(0, keys[1], "room", { reporter_epoch: "epoch-one", seq: 2 })).status).toBe(200);
    expect((await report(0, keys[1], "room", { reporter_epoch: "epoch-one", seq: 1, ice_direct: false, wg_reachable: false })).status).toBe(200);
    expect((await report(1, keys[2])).status).toBe(200);
    expect(edges()).toHaveLength(2);
    expect(edges().find((e) => e.src_public_key === keys[0])?.seq).toBe(2);
    const response = await config(0);
    const body = await response.json<{ peers: Array<{ public_key: string; next_hop_public_key?: string }> }>();
    expect(body.peers.find((p) => p.public_key === keys[2])?.next_hop_public_key).toBe(keys[1]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4); // Only config reads consult service.
  });
  it("allows the existing exact-key pair contract without room leases", async () => {
    expect((await report(0, keys[1], pair(keys[0], keys[1]))).status).toBe(200);
    expect(edges()).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects pair reports about a nonexistent registered peer", async () => {
    expect((await report(0, keys[4], pair(keys[0], keys[4]))).status).toBe(403);
    expect(edges()).toHaveLength(0);
  });
  it("checks scope in the write statement when a peer leaves concurrently", async () => {
    await joinRoom();
    beforeUpsert = () => db.prepare("DELETE FROM peer_presence WHERE public_key=?").run(keys[1]);
    expect((await report()).status).toBe(403);
    expect(edges()).toHaveLength(0);
  });
  it("cannot recreate edges after the reporting peer is revoked concurrently", async () => {
    beforeUpsert = () => db.prepare("DELETE FROM peers WHERE public_key=?").run(keys[0]);
    expect((await report(0, keys[1], pair(keys[0], keys[1]))).status).toBe(403);
    expect(edges()).toHaveLength(0);
  });
});
