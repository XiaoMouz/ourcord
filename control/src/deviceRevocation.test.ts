import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { makeToken, signToken } from "./auth";
import type { Env } from "./types";

const aliceKey = "A".repeat(43) + "=";
const bobKey = "B".repeat(43) + "=";

describe("device revocation ownership (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  let topologyDelete: { sql: string; params: unknown[] };
  const secret = "device-revocation-test-secret";

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, name), "utf8"));
    }
    const prepare = (sql: string) => {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async run() {
          if (/DELETE FROM peer_connectivity/.test(sql)) topologyDelete = { sql, params };
          return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
        },
      };
      return statement;
    };
    env = {
      ENVIRONMENT: "development", JWT_SECRET: secret,
      DB: {
        prepare,
        async batch(statements: ReturnType<typeof prepare>[]) {
          db.exec("BEGIN");
          try {
            const results = [];
            for (const statement of statements) results.push(await statement.run());
            db.exec("COMMIT");
            return results;
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        },
      } as unknown as D1Database,
    } as Env;
    db.exec("INSERT INTO users(id,email,created_at) VALUES ('alice','alice@example.test',1),('bob','bob@example.test',1)");
    db.prepare("INSERT INTO peers(id,user_id,public_key,ip4,ip6) VALUES ('alice-peer','alice',?,'198.19.0.1','fd01::1'),('bob-peer','bob',?,'198.19.0.2','fd01::2')")
      .run(aliceKey, bobKey);
    db.prepare("INSERT INTO peer_presence VALUES (?,'network-one',1)").run(aliceKey);
    const insert = db.prepare("INSERT INTO peer_connectivity(network_id,src_public_key,dst_public_key,reported_at) VALUES (?,?,?,1)");
    insert.run("network-one", aliceKey, bobKey);
    insert.run("network-one", bobKey, aliceKey);
    insert.run("network-two", aliceKey, bobKey);
    insert.run("unrelated", bobKey, "another-peer");
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  async function call(user: string, path: string, method = "POST", data?: unknown) {
    const token = await signToken(makeToken(user, `${user}@example.test`), secret);
    return worker.fetch(new Request(`https://control.test${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }), env, {} as ExecutionContext);
  }
  async function enroll(user: string, key = aliceKey) {
    const response = await call(user, "/api/devices/enroll", "POST", { public_key: key });
    expect(response.status).toBe(201);
    return response.json<{ id: string; device_token: string }>();
  }
  function edges() {
    return db.prepare("SELECT * FROM peer_connectivity ORDER BY network_id,src_public_key,dst_public_key").all() as Array<{ network_id: string }>;
  }

  it("cannot delete Alice's topology by enrolling her public key under Bob's account", async () => {
    const before = edges();
    const device = await enroll("bob");
    expect((await call("bob", `/api/devices/${device.id}`, "DELETE")).status).toBe(200);
    expect(edges()).toEqual(before);
    expect(db.prepare("SELECT user_id FROM peers WHERE public_key=?").get(aliceKey)).toEqual({ user_id: "alice" });
    expect(db.prepare("SELECT public_key FROM peer_presence").all()).toEqual([{ public_key: aliceKey }]);
    expect((await call("bob", "/api/auth/device", "POST", { device_token: device.device_token })).status).toBe(401);
  });

  it("retires the owner's peer, presence and both directions across networks", async () => {
    const device = await enroll("alice");
    expect((await call("alice", `/api/devices/${device.id}`, "DELETE")).status).toBe(200);
    expect(edges().map((row) => row.network_id)).toEqual(["unrelated"]);
    expect(db.prepare("SELECT id FROM peers WHERE user_id='alice'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM peer_presence").all()).toEqual([]);
    expect((await call("alice", `/api/devices/${device.id}`, "DELETE")).status).toBe(404);
  });

  it("rejects revoking another user's credential before any topology mutation", async () => {
    const device = await enroll("alice");
    const before = edges();
    expect((await call("bob", `/api/devices/${device.id}`, "DELETE")).status).toBe(404);
    expect(edges()).toEqual(before);
    expect(db.prepare("SELECT revoked_at FROM device_tokens WHERE id=?").get(device.id)).toEqual({ revoked_at: null });
  });

  it.each(["DELETE ON peers", "UPDATE ON device_tokens"])("rolls back the whole revocation when %s fails", async (operation) => {
    const device = await enroll("alice");
    const before = edges();
    db.exec(`CREATE TRIGGER fail_revocation BEFORE ${operation} BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END`);
    // The route's async error-boundary fix may return JSON 500 instead of rejecting.
    try {
      expect((await call("alice", `/api/devices/${device.id}`, "DELETE")).status).toBe(500);
    } catch (error) { expect(String(error)).toContain("injected deletion failure"); }
    expect(edges()).toEqual(before);
    expect(db.prepare("SELECT revoked_at FROM device_tokens WHERE id=?").get(device.id)).toEqual({ revoked_at: null });
    expect(db.prepare("SELECT id FROM peers WHERE user_id='alice'").get()).toBeDefined();
    expect(db.prepare("SELECT public_key FROM peer_presence").all()).toEqual([{ public_key: aliceKey }]);
    db.exec("DROP TRIGGER fail_revocation");
    expect((await call("alice", `/api/devices/${device.id}`, "DELETE")).status).toBe(200);
  });

  it("looks up each edge direction without scanning unrelated networks", async () => {
    const device = await enroll("alice");
    expect((await call("alice", `/api/devices/${device.id}`, "DELETE")).status).toBe(200);
    const plans = db.prepare(`EXPLAIN QUERY PLAN ${topologyDelete.sql}`).all(...topologyDelete.params) as Array<{ detail: string }>;
    const detail = plans.map((row) => row.detail).join("\n");
    expect(detail).toContain("idx_peer_connectivity_src");
    expect(detail).toContain("idx_peer_connectivity_dst");
    expect(detail).not.toMatch(/SCAN peer_connectivity/);
  });
});
