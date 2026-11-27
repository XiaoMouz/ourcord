import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { deleteMessage, getMessages, sendMessage } from "./messages";
import type { Env, Message } from "./types";

describe("message history after cursor deletion (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  const secret = "message-history-test-secret";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, name), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1', 'history', 'owner', NULL, 1);
      INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','chat'), ('R2','L1','other chat');
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at)
        VALUES ('L1','owner','owner',1), ('L1','reader','member',1);
    `);
    const prepare = (sql: string) => {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async all() { return { results: db.prepare(sql).all(...params) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
      };
      return statement;
    };
    env = { ENVIRONMENT: "production", JWT_SECRET: secret, DB: { prepare } as unknown as D1Database } as Env;
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  async function request(user = "reader", query = "", method = "GET", body?: unknown) {
    const payload = btoa(JSON.stringify({ sub: user, exp: 9999999999 }));
    return new Request(`https://service.test/api/rooms/R1/messages${query}`, {
      method, headers: { Authorization: `Bearer ${payload}.${await hmacSign(secret, payload)}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function history(query = "") {
    const response = await getMessages(await request("reader", query), env, "R1");
    expect(response.status).toBe(200);
    return (await response.json<{ messages: Message[] }>()).messages;
  }
  async function send(content: string) {
    const response = await sendMessage(await request("owner", "", "POST", { content }), env, "R1");
    expect(response.status).toBe(201);
    return response.json<Message>();
  }
  async function remove(id: string) {
    expect((await deleteMessage(await request("owner", "", "DELETE"), env, "R1", id)).status).toBe(200);
  }

  it("loads older history after another member deletes the first visible message", async () => {
    const sent = [];
    for (let i = 0; i < 65; i++) {
      sent.push(await send(`Message ${i}`));
      vi.advanceTimersByTime(6_000);
    }
    const first = await history();
    expect(first.map((message) => message.id)).toEqual(sent.slice(15).map((message) => message.id));
    const boundary = first[0];
    await remove(boundary.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE created_at < ?").get(boundary.created_at)).toEqual({ n: 15 });
    const older = await history(`?before=${boundary.id}&before_created_at=${boundary.created_at}`);
    expect(older.map((message) => message.id)).toEqual(sent.slice(0, 15).map((message) => message.id));
  });

  it("keeps same-second pagination exclusive even when the boundary is deleted", async () => {
    const sent = await Promise.all(["one", "two", "three"].map(send));
    const ordered = [...sent].sort((a, b) => a.id < b.id ? -1 : 1);
    const first = await history("?limit=2");
    expect(first.map((message) => message.id)).toEqual(ordered.slice(1).map((message) => message.id));
    const boundary = first[0];
    await remove(boundary.id);
    const older = await history(`?limit=2&before=${boundary.id}&before_created_at=${boundary.created_at}`);
    expect(older.map((message) => message.id)).toEqual([ordered[0].id]);
  });

  it("preserves legacy ID-only pagination and rejects foreign legacy cursors", async () => {
    const earlier = await send("earlier");
    vi.advanceTimersByTime(1_000);
    const later = await send("later");
    expect((await history(`?before=${later.id}`)).map((message) => message.id)).toEqual([earlier.id]);
    db.prepare("INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES ('foreign','R2','owner','private',?)")
      .run(later.created_at);
    expect(await history("?before=foreign")).toEqual([]);
    expect(await history("?before=missing")).toEqual([]);
    // The explicit tuple is only a position within the authorized room.
    expect((await history(`?before=zzzz&before_created_at=${later.created_at + 1}`)).map((message) => message.id))
      .toEqual([earlier.id, later.id]);
  });

  it.each(["", "-1", "NaN", "1.5", "1e3", "3abc", "9007199254740992"])(
    "rejects invalid before_created_at %j", async (timestamp) => {
      const response = await getMessages(await request("reader", `?before=missing&before_created_at=${timestamp}`), env, "R1");
      expect(response.status).toBe(400);
    },
  );

  it("requires a boundary ID with an explicit timestamp", async () => {
    expect((await getMessages(await request("reader", "?before_created_at=123"), env, "R1")).status).toBe(400);
  });

  it("preserves membership checks for tuple pagination", async () => {
    expect((await getMessages(await request("outsider", "?before=any&before_created_at=123"), env, "R1")).status).toBe(403);
  });
});
