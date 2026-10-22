import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { deleteRoom, updateRoom } from "./lobby";
import type { Env } from "./types";

describe("partial room updates (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  let token: string;
  let afterRoomRead: (() => Promise<void>) | undefined;
  let writes: number;

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
      INSERT INTO rooms(id, lobby_id, name, position) VALUES
        ('R1', 'L1', 'original', 0), ('R2', 'L1', 'other', 1);
    `);
    afterRoomRead = undefined;
    writes = 0;
    env = {
      ENVIRONMENT: "production", JWT_SECRET: "test-room-patch-secret",
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) { params = values; return statement; },
            async first() {
              if (/^UPDATE rooms/i.test(sql)) writes++;
              const row = db.prepare(sql).get(...params) ?? null;
              if (sql === "SELECT * FROM rooms WHERE id = ?" && afterRoomRead) {
                const hook = afterRoomRead;
                afterRoomRead = undefined;
                await hook();
              }
              return row;
            },
            async run() {
              if (/^UPDATE rooms/i.test(sql)) writes++;
              return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
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

  function patch(body: unknown) {
    return updateRoom(new Request("https://service.test/api/rooms/R1", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env, "R1");
  }

  // Pause one real handler after it captured its row, then let a second
  // authenticated request commit before the first handler resumes.
  async function pausePatch(body: unknown) {
    let captured!: () => void;
    let resume!: () => void;
    const read = new Promise<void>((resolve) => { captured = resolve; });
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    afterRoomRead = async () => { captured(); await wait; };
    const response = patch(body);
    await Promise.race([read, response.then(() => { throw new Error("PATCH returned before reading the room"); })]);
    return { response, resume };
  }

  it.each([
    [{ name: "renamed" }, { position: 7 }],
    [{ position: 7 }, { name: "renamed" }],
  ])("preserves both edits when %j reads before %j commits", async (first, second) => {
    const pending = await pausePatch(first);
    let other: Response;
    try {
      other = await patch(second);
    } finally {
      pending.resume();
    }
    const response = await pending.response;
    expect(other!.status).toBe(200);
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT name, position FROM rooms WHERE id = 'R1'").get())
      .toEqual({ name: "renamed", position: 7 });
    expect(await response.json()).toMatchObject({ name: "renamed", position: 7 });
  });

  it("treats an empty patch as a read and preserves an intervening rename", async () => {
    const pending = await pausePatch({});
    try {
      expect((await patch({ name: "renamed" })).status).toBe(200);
    } finally {
      pending.resume();
    }
    const response = await pending.response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "renamed", position: 0 });
    expect(db.prepare("SELECT name FROM rooms WHERE id = 'R1'").get()).toEqual({ name: "renamed" });
    expect(writes).toBe(1);
  });

  it.each([{ name: "renamed" }, {}])("returns 404 if another client deleted the room before patch %j", async (body) => {
    const pending = await pausePatch(body);
    try {
      const response = await deleteRoom(new Request("https://service.test/api/rooms/R1", {
        method: "DELETE", headers: { Authorization: `Bearer ${token}` },
      }), env, "R1");
      expect(response.status).toBe(200);
    } finally {
      pending.resume();
    }
    expect((await pending.response).status).toBe(404);
    expect(db.prepare("SELECT id FROM rooms WHERE id = 'R1'").get()).toBeUndefined();
  });

  it("updates both fields together, including position zero and normalized names", async () => {
    db.exec("UPDATE rooms SET position = 8 WHERE id = 'R1'");
    const response = await patch({ name: "  renamed  ", position: 0 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "renamed", position: 0 });
    expect(writes).toBe(1);
  });

  it.each([
    { name: "" }, { name: 1 }, { position: -1 }, { position: 1.5 },
    { position: 100001 }, { name: "renamed", position: "2" },
  ])("rejects invalid fields without partial writes: %j", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(writes).toBe(0);
    expect(db.prepare("SELECT name, position FROM rooms WHERE id = 'R1'").get())
      .toEqual({ name: "original", position: 0 });
  });

  it("keeps member authorization on partial and empty updates", async () => {
    db.exec("UPDATE lobby_members SET role = 'member'");
    for (const body of [{ name: "renamed" }, { position: 2 }, {}]) {
      expect((await patch(body)).status).toBe(403);
    }
    expect(writes).toBe(0);
  });
});
