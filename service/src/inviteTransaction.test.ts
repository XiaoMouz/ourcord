import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { createInvite, joinLobby } from "./lobby";
import type { Env } from "./types";

describe("invite redemption transaction (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  let code: string;
  let membershipReadBarrier: (() => Promise<void>) | undefined;
  const secret = "invite-transaction-test-secret";

  beforeEach(async () => {
    membershipReadBarrier = undefined;
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, file), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1', 'test', 'owner', NULL, 1);
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('L1','owner','owner',1);
    `);
    const prepare = (sql: string) => {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async first() {
          const row = db.prepare(sql).get(...params) ?? null;
          if (sql.startsWith("SELECT role FROM lobby_members") && membershipReadBarrier) {
            await membershipReadBarrier();
          }
          return row;
        },
        execute() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
        async run() { return statement.execute(); },
      };
      return statement;
    };
    env = {
      ENVIRONMENT: "production", JWT_SECRET: secret,
      DB: {
        prepare,
        async batch(statements: ReturnType<typeof prepare>[]) {
          // No await inside the transaction: another request must not
          // interleave statements within D1's atomic batch.
          db.exec("BEGIN");
          try {
            const results = statements.map((statement) => statement.execute());
            db.exec("COMMIT");
            return results;
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        },
      } as unknown as D1Database,
    } as Env;
    // Use the actual owner API default: seven-day, single-use invite.
    const response = await createInvite(await request("owner", {}), env, "L1");
    expect(response.status).toBe(201);
    code = (await response.json<{ code: string }>()).code;
  });
  afterEach(() => db.close());

  async function request(userID: string, body: unknown) {
    const payload = btoa(JSON.stringify({ sub: userID, exp: 9999999999 }));
    return new Request("https://service.test/api/lobbies/L1/join", {
      method: "POST",
      headers: { Authorization: `Bearer ${payload}.${await hmacSign(secret, payload)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function redeem(userID = "guest") {
    return joinLobby(await request(userID, { code }), env, "L1");
  }
  function uses() {
    return db.prepare("SELECT uses FROM lobby_invites WHERE code = ?").get(code);
  }
  function guests() {
    return db.prepare("SELECT user_id FROM lobby_members WHERE user_id != 'owner' ORDER BY user_id").all();
  }
  function synchronizeMembershipReads(count: number) {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    membershipReadBarrier = async () => {
      if (--count === 0) release();
      await ready;
    };
  }

  it("rolls back consumption after a membership write failure so retry can join", async () => {
    db.exec(`CREATE TRIGGER fail_membership BEFORE INSERT ON lobby_members
      BEGIN SELECT RAISE(ABORT, 'injected membership write failure'); END`);
    await expect(redeem()).rejects.toThrow("injected membership write failure");
    expect(uses()).toEqual({ uses: 0 });
    expect(guests()).toEqual([]);
    db.exec("DROP TRIGGER fail_membership");
    expect((await redeem()).status).toBe(200);
    expect(uses()).toEqual({ uses: 1 });
    expect(guests()).toEqual([{ user_id: "guest" }]);
  });

  it("does not charge twice when the same account opens an invite on two clients", async () => {
    db.exec("UPDATE lobby_invites SET max_uses = 2");
    synchronizeMembershipReads(2);
    const responses = await Promise.all([redeem(), redeem()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(uses()).toEqual({ uses: 1 });
    expect(guests()).toEqual([{ user_id: "guest" }]);
    expect((await redeem("friend")).status).toBe(200);
    expect(uses()).toEqual({ uses: 2 });
  });

  it("returns success for duplicate single-use redemption by the same account", async () => {
    synchronizeMembershipReads(2);
    const responses = await Promise.all([redeem(), redeem()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(uses()).toEqual({ uses: 1 });
    expect(guests()).toEqual([{ user_id: "guest" }]);
  });

  it("admits only one distinct account with a single-use invite", async () => {
    synchronizeMembershipReads(12);
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => redeem(`guest-${i}`)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 403)).toHaveLength(11);
    expect(uses()).toEqual({ uses: 1 });
    expect(guests()).toHaveLength(1);
  });

  it("rolls back membership if consuming the invite fails", async () => {
    db.exec(`CREATE TRIGGER fail_invite BEFORE UPDATE ON lobby_invites
      BEGIN SELECT RAISE(ABORT, 'injected invite write failure'); END`);
    await expect(redeem()).rejects.toThrow("injected invite write failure");
    expect(uses()).toEqual({ uses: 0 });
    expect(guests()).toEqual([]);
  });

  it("does not consume a different lobby's invite", async () => {
    db.exec("INSERT INTO lobbies VALUES ('L2', 'other', 'owner', NULL, 1)");
    db.prepare("UPDATE lobby_invites SET lobby_id = 'L2' WHERE code = ?").run(code);
    expect((await redeem()).status).toBe(403);
    expect(uses()).toEqual({ uses: 0 });
    expect(guests()).toEqual([]);
  });

  it("keeps unlimited invites usable and counts each account only once", async () => {
    db.exec("UPDATE lobby_invites SET max_uses = 0");
    synchronizeMembershipReads(2);
    const responses = await Promise.all([redeem(), redeem()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(uses()).toEqual({ uses: 1 });
    expect((await redeem("friend")).status).toBe(200);
    expect(uses()).toEqual({ uses: 2 });
  });

  it.each(["UPDATE lobby_invites SET revoked = 1", "UPDATE lobby_invites SET expires_at = 1", "UPDATE lobby_invites SET uses = max_uses"])(
    "does not grant membership when invalid: %s", async (sql) => {
      db.exec(sql);
      expect((await redeem()).status).toBe(403);
      expect(guests()).toEqual([]);
    },
  );
});
