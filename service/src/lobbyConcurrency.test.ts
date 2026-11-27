import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { deleteRoom } from "./lobby";
import type { Env } from "./types";

describe("room deletion concurrency (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  let token: string;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, file), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1', 'test', 'u1', NULL, 1);
      INSERT INTO lobby_members(lobby_id, user_id, role, joined_at) VALUES ('L1', 'u1', 'owner', 1);
      INSERT INTO rooms(id, lobby_id, name) VALUES ('R1', 'L1', 'one'), ('R2', 'L1', 'two');
    `);
    // Hold both legacy COUNT reads after evaluating them so the regression
    // deterministically exercises two owner clients deleting different rooms.
    let countReads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    env = {
      ENVIRONMENT: "production", JWT_SECRET: "test-room-concurrency",
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) { params = values; return statement; },
            async first() {
              const row = db.prepare(sql).get(...params) ?? null;
              if (sql.startsWith("SELECT COUNT(*) AS c FROM rooms")) {
                if (++countReads === 2) release();
                await bothRead;
              }
              return row;
            },
            async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
          };
          return statement;
        },
      } as unknown as D1Database,
    } as Env;
    const payload = btoa(JSON.stringify({ sub: "u1", exp: 9999999999 }));
    token = `${payload}.${await hmacSign(env.JWT_SECRET!, payload)}`;
  });
  afterEach(() => db.close());

  function remove(room: string) {
    return deleteRoom(new Request(`https://service.test/api/rooms/${room}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    }), env, room);
  }

  it("keeps one room when the owner deletes the final two rooms from separate clients", async () => {
    const responses = await Promise.all([remove("R1"), remove("R2")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 1 });
  });
});
