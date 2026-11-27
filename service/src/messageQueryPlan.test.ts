import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { getMessages } from "./messages";
import type { Env, Message } from "./types";

describe("message history index use (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  let token: string;
  let plan: string[];
  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, name), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1', 'history', 'u1', NULL, 1);
      INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','chat'), ('R2','L1','other');
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('L1','u1','owner',1);
    `);
    const insert = db.prepare("INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES (?,'R1','u1','burst',100)");
    for (let i = 0; i < 120; i++) insert.run(`message-${String(i).padStart(3, "0")}`);
    plan = [];
    env = {
      ENVIRONMENT: "production", JWT_SECRET: "test-message-query-plan",
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) { params = values; return statement; },
            async first() { return db.prepare(sql).get(...params) ?? null; },
            async all() {
              const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
              plan = rows.map((row) => row.detail);
              return { results: db.prepare(sql).all(...params) };
            },
          };
          return statement;
        },
      } as unknown as D1Database,
    } as Env;
    const payload = btoa(JSON.stringify({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 }));
    token = `${payload}.${await hmacSign(env.JWT_SECRET!, payload)}`;
  });
  afterEach(() => db.close());

  async function read(query: string) {
    const response = await getMessages(new Request(`https://service.test/api/rooms/R1/messages${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }), env, "R1");
    expect(response.status).toBe(200);
    return (await response.json<{ messages: Message[] }>()).messages;
  }

  it.each([
    ["", 70],
    ["?before=message-060&before_created_at=100", 10],
    ["?before=message-060", 10],
  ])("reads an ordered page without sorting the entire timestamp group: %s", async (query, start) => {
    const page = await read(query);
    expect(page.map((message) => message.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `message-${String(start + i).padStart(3, "0")}`),
    );
    expect(plan.some((detail) => /TEMP B-TREE/.test(detail)), plan.join("\n")).toBe(false);
    if (query) {
      expect(plan.some((detail) => detail.replaceAll(" ", "").includes("(created_at,id)<(?,?)")), plan.join("\n")).toBe(true);
    }
  });

  it("keeps a legacy cursor scoped to the room and returns no data for a missing cursor", async () => {
    db.exec("INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES ('foreign','R2','u1','private',100)");
    expect(await read("?before=foreign")).toEqual([]);
    expect(await read("?before=missing")).toEqual([]);
  });

  it("upgrades an existing populated index without losing messages or retaining redundant indexes", () => {
    db.exec(`
      DROP INDEX idx_messages_room_cursor;
      CREATE INDEX idx_messages_room ON messages(room_id, created_at);
    `);
    const before = db.prepare("SELECT * FROM messages ORDER BY id").all();
    const migration = readFileSync(join(__dirname, "../migrations/0007_message_history_cursor_index.sql"), "utf8");
    db.exec(migration);
    db.exec(migration);
    expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(before);
    const indexes = (db.prepare("PRAGMA index_list(messages)").all() as { name: string }[]).map((row) => row.name);
    expect(indexes).toContain("idx_messages_room_cursor");
    expect(indexes).not.toContain("idx_messages_room");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
