import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import worker from "./index";
import type { Env } from "./types";

describe("member role write authorization", () => {
  let db: DatabaseSync;
  let env: Env;
  let beforeWrite: (() => Promise<void>) | undefined;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const directory = join(__dirname, "../migrations");
    for (const file of readdirSync(directory).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(directory, file), "utf8"));
    db.exec(`INSERT INTO lobbies VALUES ('L1','lobby','owner',NULL,1), ('L2','other','admin',NULL,1);
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES
      ('L1','owner','owner',1), ('L1','admin','admin',1), ('L1','target','member',1),
      ('L2','admin','owner',1), ('L2','foreign-owner','member',1);`);
    beforeWrite = undefined;
    env = { ENVIRONMENT: "development", JWT_SECRET: "member-role-test-secret",
      DB: { prepare(sql: string) {
        let params: unknown[] = [];
        const s = {
          bind(...values: unknown[]) { params = values; return s; },
          async first() { return db.prepare(sql).get(...params) ?? null; },
          async run() {
            if (sql.includes("UPDATE lobby_members")) { const hook = beforeWrite; beforeWrite = undefined; await hook?.(); }
            return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
          },
        }; return s;
      } },
    } as unknown as Env;
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  async function update(caller: string, target: string, role: string, lobby = "L1") {
    const payload = btoa(JSON.stringify({ sub: caller, exp: Math.floor(Date.now() / 1000) + 3600 }));
    const token = `${payload}.${await hmacSign(env.JWT_SECRET!, payload)}`;
    return worker.fetch(new Request(`https://service.test/api/lobbies/${lobby}/members/${target}`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    }), env, {} as ExecutionContext);
  }
  async function pausedUpdate(caller: string, target: string, role: string) {
    let captured!: () => void, resume!: () => void;
    const reached = new Promise<void>((resolve) => { captured = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    beforeWrite = async () => { captured(); await gate; };
    const response = update(caller, target, role);
    await Promise.race([reached, response.then(() => { throw new Error("role update returned before the write gate"); })]);
    return { response, resume };
  }
  const roleOf = (id: string) => (db.prepare("SELECT role FROM lobby_members WHERE lobby_id='L1' AND user_id=?").get(id) as { role: string }).role;

  it("cannot demote a newly promoted admin with an earlier member-role request", async () => {
    const stale = await pausedUpdate("admin", "target", "guest");
    try { expect((await update("owner", "target", "admin")).status).toBe(200); }
    finally { stale.resume(); }
    expect((await stale.response).status).toBe(403);
    expect(roleOf("target")).toBe("admin");
  });
  it("rejects a pending administrator write after the owner revokes that privilege", async () => {
    const stale = await pausedUpdate("admin", "target", "guest");
    try { expect((await update("owner", "admin", "member")).status).toBe(200); }
    finally { stale.resume(); }
    expect((await stale.response).status).toBe(403);
    expect(roleOf("target")).toBe("member");
    // Being an owner in another lobby must not satisfy the write predicate.
    expect(roleOf("admin")).toBe("member");
  });
  it("keeps owner authority and ordinary administrator edits", async () => {
    expect((await update("admin", "target", "guest")).status).toBe(200);
    expect(roleOf("target")).toBe("guest");
    expect((await update("admin", "target", "guest")).status).toBe(200);
    expect((await update("owner", "target", "admin")).status).toBe(200);
    expect((await update("admin", "target", "member")).status).toBe(403);
    expect((await update("owner", "target", "member")).status).toBe(200);
    expect((await update("admin", "owner", "guest")).status).toBe(403);
    expect(roleOf("owner")).toBe("owner");
  });
  it("keeps 404 for missing targets and denies ordinary members", async () => {
    expect((await update("owner", "missing", "guest")).status).toBe(404);
    expect((await update("target", "admin", "member")).status).toBe(403);
  });
});
