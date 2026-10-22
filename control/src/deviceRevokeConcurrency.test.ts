import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeToken, signToken } from "./auth";
import worker from "./index";
import type { Env } from "./types";

describe("device credential rotation versus pending revocation", () => {
  let db: DatabaseSync;
  let env: Env;
  let token: string;
  let beforeBatch: (() => Promise<void>) | undefined;
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const directory = join(__dirname, "../migrations");
    for (const file of readdirSync(directory).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(directory, file), "utf8"));
    db.exec("INSERT INTO users(id,email,created_at) VALUES ('owner','owner@example.test',1)");
    db.prepare("INSERT INTO peers(id,user_id,public_key,ip4,ip6) VALUES ('peer','owner',?,'198.19.0.1','fd01::1')").run(key);
    db.prepare("INSERT INTO peer_presence VALUES (?,'network',1)").run(key);
    db.prepare("INSERT INTO peer_connectivity(network_id,src_public_key,dst_public_key,reported_at) VALUES ('network',?,'other',1)").run(key);
    beforeBatch = undefined;
    env = { ENVIRONMENT: "development", JWT_SECRET: "rotation-test-secret", DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        const stmt = {
          bind(...values: unknown[]) { params = values; return stmt; },
          async first() { return db.prepare(sql).get(...params) ?? null; },
          async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
        };
        return stmt;
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        const hook = beforeBatch;
        beforeBatch = undefined;
        await hook?.();
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec("COMMIT");
          return results;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    } } as unknown as Env;
    token = await signToken(makeToken("owner", "owner@example.test"), env.JWT_SECRET!);
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  const call = (path: string, method: string, body?: unknown) => worker.fetch(new Request(`https://control.test/api/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {} as ExecutionContext);
  async function enroll() {
    const response = await call("devices/enroll", "POST", { public_key: key, name: "computer" });
    expect(response.status).toBe(201);
    return response.json<{ id: string }>();
  }
  async function pendingRevoke(id: string) {
    let entered!: () => void, resume!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    beforeBatch = async () => { entered(); await gate; };
    const response = call(`devices/${id}`, "DELETE");
    await Promise.race([reached, response.then(() => { throw new Error("revoke returned before batch gate"); })]);
    return { response, resume };
  }

  it("does not remove network state belonging to a newly rotated credential", async () => {
    const old = await enroll();
    const pending = await pendingRevoke(old.id);
    let fresh!: { id: string };
    try { fresh = await enroll(); }
    finally { pending.resume(); }
    expect.soft((await pending.response).status).toBe(404);
    expect(db.prepare("SELECT id,revoked_at FROM device_tokens").all()).toEqual([{ id: fresh.id, revoked_at: null }]);
    expect.soft(db.prepare("SELECT id FROM peers").all()).toEqual([{ id: "peer" }]);
    expect.soft(db.prepare("SELECT public_key FROM peer_presence").all()).toEqual([{ public_key: key }]);
    expect.soft(db.prepare("SELECT src_public_key FROM peer_connectivity").all()).toEqual([{ src_public_key: key }]);
  });

  it("reports an already completed concurrent revocation as missing", async () => {
    const old = await enroll();
    const pending = await pendingRevoke(old.id);
    try { expect((await call(`devices/${old.id}`, "DELETE")).status).toBe(200); }
    finally { pending.resume(); }
    expect((await pending.response).status).toBe(404);
  });

  it("still retires the credential, peer, presence and topology on an ordinary revoke", async () => {
    const old = await enroll();
    expect((await call(`devices/${old.id}`, "DELETE")).status).toBe(200);
    expect(db.prepare("SELECT revoked_at FROM device_tokens WHERE id=?").get(old.id)).toMatchObject({ revoked_at: expect.any(Number) });
    for (const table of ["peers", "peer_presence", "peer_connectivity"]) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  });
});
