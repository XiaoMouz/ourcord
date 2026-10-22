import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { hmacSign } from "./auth";
import { SCHEMA_SQL } from "./schema";
import type { Env } from "./types";

const secret = "test-presence-retirement";

describe.each(["migrations", "development schema"])("presence retirement with %s", (schema) => {
  let db: DatabaseSync;
  let env: Env;
  let plans: string[];
  let beforeDelete: (() => void) | undefined;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    if (schema === "migrations") {
      const dir = join(__dirname, "../migrations");
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        db.exec(readFileSync(join(dir, file), "utf8"));
      }
    } else db.exec(SCHEMA_SQL);
    db.exec(`
      INSERT INTO lobbies VALUES ('L1','friends','owner',NULL,1), ('L2','friends','owner',NULL,1), ('L3','other','other',NULL,1);
      INSERT INTO rooms(id,lobby_id,name,type) VALUES ('R1','L1','voice','voice');
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES
        ('L1','me','member',1), ('L2','me','member',1),
        ('L1','other','member',1), ('L2','other','member',1), ('L3','other','member',1);
      INSERT INTO lobby_presence(lobby_id,user_id,last_seen,voice_room_id) VALUES
        ('L1','me',9999999999,'R1'), ('L2','me',1,NULL),
        ('L1','other',9999999999,'R1'), ('L2','other',1,NULL), ('L3','other',1,NULL);
    `);
    plans = [];
    beforeDelete = undefined;
    env = {
      JWT_SECRET: secret, ENVIRONMENT: "production",
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) { params = values; return statement; },
            async run() {
              beforeDelete?.();
              const queryPlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
              plans.push(...queryPlan.map((row) => row.detail));
              return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
            },
          };
          return statement;
        },
      } as unknown as D1Database,
    } as Env;
  });
  afterEach(() => db.close());

  async function retire(user = "me", authenticated = true) {
    const payload = btoa(JSON.stringify({ sub: user, exp: 9999999999 }));
    const token = `${payload}.${await hmacSign(secret, payload)}`;
    return worker.fetch(new Request("https://service.test/api/presence", {
      method: "DELETE", headers: authenticated ? { Authorization: `Bearer ${token}` } : {},
    }), env, {} as ExecutionContext);
  }
  const otherPresence = () => db.prepare("SELECT * FROM lobby_presence WHERE user_id = 'other' ORDER BY lobby_id").all();

  it("removes active and expired own rows while preserving every other member", async () => {
    const others = otherPresence();
    const response = await retire();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ online: false });
    expect(db.prepare("SELECT * FROM lobby_presence WHERE user_id = 'me'").all()).toEqual([]);
    expect(otherPresence()).toEqual(others);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lobby_members WHERE user_id = 'me'").get()).toEqual({ n: 2 });
    expect(plans.some((plan) => /SCAN lobby_presence\b/.test(plan))).toBe(false);
    expect(plans.some((plan) => /SEARCH lobby_presence.*lobby_id=\? AND user_id=\?/.test(plan))).toBe(true);
  });

  it("keeps repeat and nonmember retirements scoped to account indexes", async () => {
    const others = otherPresence();
    for (const user of ["me", "me", "nonmember"]) expect((await retire(user)).status).toBe(200);
    expect(otherPresence()).toEqual(others);
    expect(plans.some((plan) => /SCAN (lobby_presence|lobby_members)\b/.test(plan))).toBe(false);
  });

  it("handles membership removal immediately before retirement via the presence FK", async () => {
    beforeDelete = () => db.exec("DELETE FROM lobby_members WHERE lobby_id = 'L1' AND user_id = 'me'");
    expect((await retire()).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lobby_presence WHERE user_id = 'me'").get()).toEqual({ n: 0 });
    expect(otherPresence()).toHaveLength(3);
  });

  it("does not access D1 without authentication", async () => {
    expect((await retire("me", false)).status).toBe(401);
    expect(plans).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lobby_presence").get()).toEqual({ n: 5 });
  });
});
