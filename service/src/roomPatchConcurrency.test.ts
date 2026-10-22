import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import worker from "./index";
import { deleteRoom } from "./lobby";
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
            async all() {
              writes++;
              return { results: db.prepare(sql).all(...params) };
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
    const reorder = !!body && typeof body === "object" && ("swap_with" in body || "expected_position" in body);
    return worker.fetch(new Request(`https://service.test/api/rooms/R1${reorder ? "/reorder" : ""}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env, {} as ExecutionContext);
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

  const swap = { swap_with: "R2", expected_position: 0, position: 1 };
  const positions = () => db.prepare("SELECT id, position FROM rooms ORDER BY id").all();

  it("swaps exactly two stored positions and returns the source room", async () => {
    db.exec("INSERT INTO rooms(id,lobby_id,name,position) VALUES ('R3','L1','unrelated',2)");
    const response = await patch(swap);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "R1", name: "original", position: 1 });
    expect(positions()).toEqual([{ id: "R1", position: 1 }, { id: "R2", position: 0 }, { id: "R3", position: 2 }]);
    expect(writes).toBe(1);
  });

  it.each(["R1", "R2"])("rejects a swap if %s changed after the authorization read", async (id) => {
    const pending = await pausePatch(swap);
    try { db.prepare("UPDATE rooms SET position = 7 WHERE id = ?").run(id); }
    finally { pending.resume(); }
    const snapshot = positions();
    expect((await pending.response).status).toBe(409);
    expect(positions()).toEqual(snapshot);
  });

  it("preserves concurrent renames during an atomic reorder", async () => {
    const pending = await pausePatch(swap);
    try { expect((await patch({ name: "renamed" })).status).toBe(200); }
    finally { pending.resume(); }
    const response = await pending.response;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "renamed", position: 1 });
    expect(positions()).toEqual([{ id: "R1", position: 1 }, { id: "R2", position: 0 }]);
  });

  it("allows only one of two overlapping stale swaps to commit", async () => {
    db.exec("INSERT INTO rooms(id,lobby_id,name,position) VALUES ('R3','L1','third',2)");
    const pending = await pausePatch(swap);
    try { expect((await patch({ ...swap, swap_with: "R3", position: 2 })).status).toBe(200); }
    finally { pending.resume(); }
    expect((await pending.response).status).toBe(409);
    expect(positions()).toEqual([{ id: "R1", position: 2 }, { id: "R2", position: 1 }, { id: "R3", position: 0 }]);
  });

  it.each(["R1", "R2"])("does not partially swap if %s was deleted", async (id) => {
    const pending = await pausePatch(swap);
    try { db.prepare("DELETE FROM rooms WHERE id = ?").run(id); }
    finally { pending.resume(); }
    const snapshot = positions();
    expect((await pending.response).status).toBe(409);
    expect(positions()).toEqual(snapshot);
  });

  it.each(["foreign lobby", "different type", "missing"])("rejects a %s target without changing either room", async (kind) => {
    if (kind === "foreign lobby") {
      db.exec("INSERT INTO lobbies VALUES ('L2','foreign','other',NULL,1); UPDATE rooms SET lobby_id = 'L2' WHERE id = 'R2'");
    } else if (kind === "different type") db.exec("UPDATE rooms SET type = 'voice' WHERE id = 'R2'");
    else db.exec("DELETE FROM rooms WHERE id = 'R2'");
    const snapshot = positions();
    expect((await patch(swap)).status).toBe(409);
    expect(positions()).toEqual(snapshot);
  });

  it.each([
    { ...swap, swap_with: "R1" }, { ...swap, swap_with: "" }, { ...swap, swap_with: null },
    { ...swap, swap_with: 7 }, { ...swap, expected_position: undefined },
    { ...swap, expected_position: -1 }, { ...swap, expected_position: 0.5 },
    { ...swap, expected_position: "0" }, { ...swap, position: undefined },
    { ...swap, name: "rename and swap" }, { expected_position: 0, position: 1 },
  ])("rejects malformed swap %j without writes", async (body) => {
    const snapshot = positions();
    expect((await patch(body)).status).toBe(400);
    expect(positions()).toEqual(snapshot);
    expect(writes).toBe(0);
  });

  it.each(["member", "guest", "absent"])("rejects swaps from %s", async (role) => {
    if (role === "absent") db.exec("DELETE FROM lobby_members");
    else db.prepare("UPDATE lobby_members SET role = ?").run(role);
    expect((await patch(swap)).status).toBe(403);
    expect(writes).toBe(0);
  });

  it("returns the source even when the target sorts first", async () => {
    db.exec("UPDATE rooms SET id = 'A0' WHERE id = 'R2'");
    const response = await patch({ ...swap, swap_with: "A0" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "R1", position: 1 });
    expect(positions()).toEqual([{ id: "A0", position: 0 }, { id: "R1", position: 1 }]);
  });

  it("allows an admin to swap voice rooms, including position zero", async () => {
    db.exec("UPDATE lobby_members SET role = 'admin'; UPDATE rooms SET type = 'voice'");
    expect((await patch(swap)).status).toBe(200);
    expect(positions()).toEqual([{ id: "R1", position: 1 }, { id: "R2", position: 0 }]);
  });

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
