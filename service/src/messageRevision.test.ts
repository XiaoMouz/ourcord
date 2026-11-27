import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { deleteMessage, getMessages, sendMessage } from "./messages";
import { SCHEMA_SQL } from "./schema";
import type { Env, Message } from "./types";

describe.each(["migrations", "development schema"])("message deletion revisions with %s", (schema) => {
  let db: DatabaseSync;
  let env: Env;
  let afterRoomRead: (() => void) | undefined;
  const seed = `
    INSERT INTO lobbies VALUES ('L1','friends','moderator',NULL,1);
    INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','chat'), ('R2','L1','other');
    INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES
      ('L1','author','member',1), ('L1','reader','member',1), ('L1','moderator','owner',1);
    INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES
      ('old','R1','author','old message',1), ('new','R1','author','new message',2), ('other','R2','author','other room',1);
  `;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    if (schema === "migrations") {
      const dir = join(__dirname, "../migrations");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      db.exec(readFileSync(join(dir, files[0]), "utf8"));
      db.exec(seed);
      for (const file of files.slice(1)) db.exec(readFileSync(join(dir, file), "utf8"));
    } else { db.exec(SCHEMA_SQL); db.exec(seed); }
    afterRoomRead = undefined;
    env = { ENVIRONMENT: "production", JWT_SECRET: "message-revision-test-secret", DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { params = values; return statement; },
          async first() {
            const row = db.prepare(sql).get(...params) ?? null;
            if (sql.includes("FROM rooms")) { const action = afterRoomRead; afterRoomRead = undefined; action?.(); }
            return row;
          },
          async all() { return { results: db.prepare(sql).all(...params) }; },
          async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
        };
        return statement;
      },
    } as unknown as D1Database } as Env;
  });
  afterEach(() => db.close());
  async function request(user = "reader", method = "GET", query = "", body?: unknown) {
    const payload = btoa(JSON.stringify({ sub: user, exp: 9999999999 }));
    return new Request(`https://service.test/api/rooms/R1/messages${query}`, {
      method, headers: { Authorization: `Bearer ${payload}.${await hmacSign(env.JWT_SECRET!, payload)}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function page(room = "R1", query = "") {
    const response = await getMessages(await request("reader", "GET", query), env, room);
    expect(response.status).toBe(200);
    return response.json<{ messages: Message[]; deletion_revision: number }>();
  }
  async function remove(id: string, user = "author", room = "R1") {
    return deleteMessage(await request(user, "DELETE"), env, room, id);
  }

  it("preserves legacy rooms/messages and exposes zero before the first deletion", async () => {
    const data = await page();
    expect(data.deletion_revision).toBe(0);
    expect(data.messages.map((m) => m.id)).toEqual(["old", "new"]);
  });
  it("increments only the affected room for author and moderator deletions, including empty pages", async () => {
    expect((await remove("old")).status).toBe(200);
    expect((await page()).deletion_revision).toBe(1);
    expect((await page("R2")).deletion_revision).toBe(0);
    expect((await remove("new", "moderator")).status).toBe(200);
    expect(await page()).toEqual({ messages: [], deletion_revision: 2 });
  });
  it("does not increment for unauthorized, wrong-room or repeated deletes", async () => {
    expect((await remove("old", "reader")).status).toBe(403);
    expect((await remove("old", "outsider")).status).toBe(403);
    expect((await remove("other")).status).toBe(404);
    expect((await page()).deletion_revision).toBe(0);
    expect((await remove("old")).status).toBe(200);
    expect((await remove("old")).status).toBe(404);
    expect((await page()).deletion_revision).toBe(1);
  });
  it("keeps the revision stable for inserts and returns it on older pages", async () => {
    expect((await sendMessage(await request("author", "POST", "", { content: "latest" }), env, "R1")).status).toBe(201);
    expect((await page()).deletion_revision).toBe(0);
    await remove("old");
    expect((await page("R1", "?before=new&before_created_at=2")).deletion_revision).toBe(1);
  });
  it("rolls back the deletion if its revision update fails", async () => {
    db.exec(`CREATE TRIGGER fail_revision BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT,'revision failure'); END;`);
    await expect(remove("old")).rejects.toThrow("revision failure");
    expect((await page()).messages.map((m) => m.id)).toEqual(["old", "new"]);
    expect((await page()).deletion_revision).toBe(0);
  });
  it("counts concurrent deletions and permits room cascade deletion", async () => {
    const results = await Promise.all([remove("old"), remove("new")]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await page()).deletion_revision).toBe(2);
    db.exec("DELETE FROM rooms WHERE id='R2'");
    expect(db.prepare("SELECT * FROM messages WHERE id='other'").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("reads the revision before the page so a concurrent deletion remains visible on the next poll", async () => {
    afterRoomRead = () => db.exec("DELETE FROM messages WHERE id='old'");
    const overlapping = await page();
    expect(overlapping.deletion_revision).toBe(0);
    expect(overlapping.messages.map((m) => m.id)).toEqual(["new"]);
    expect((await page()).deletion_revision).toBe(1);
  });
});
