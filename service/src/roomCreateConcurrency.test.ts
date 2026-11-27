import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { hmacSign } from "./auth";
import type { Env, Room } from "./types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("room append positions (real SQLite and worker routes)", () => {
  let db: DatabaseSync;
  let env: Env;
  let tokens: Record<string, string>;
  let beforeInsert: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, file), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1','friends','owner',NULL,1), ('L2','other','owner',NULL,1);
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES
        ('L1','owner','owner',1), ('L1','admin','admin',1), ('L1','member','member',1);
      INSERT INTO rooms(id,lobby_id,name,position) VALUES ('R1','L1','general',0), ('other','L2','other',100);
    `);
    beforeInsert = undefined;
    env = {
      ENVIRONMENT: "production", JWT_SECRET: "room-append-test-secret",
      KV: {} as KVNamespace, FILES: {} as R2Bucket,
      RATE_LIMIT_10: { limit: async () => ({ success: true }) },
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const gate = async () => {
            if (sql.startsWith("INSERT INTO rooms")) await beforeInsert?.();
          };
          const statement = {
            bind(...values: unknown[]) { params = values; return statement; },
            async first() { await gate(); return db.prepare(sql).get(...params) ?? null; },
            async all() { await gate(); return { results: db.prepare(sql).all(...params) }; },
            async run() {
              await gate();
              return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
            },
          };
          return statement;
        },
      } as unknown as D1Database,
    } as Env;
    tokens = {};
    for (const sub of ["owner", "admin", "member", "outsider"]) {
      const payload = btoa(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }));
      tokens[sub] = `${payload}.${await hmacSign(env.JWT_SECRET!, payload)}`;
    }
  });
  afterEach(() => db.close());

  function create(body: unknown, user = "owner") {
    return worker.fetch(new Request("https://service.test/api/lobbies/L1/rooms", {
      method: "POST", headers: { Authorization: `Bearer ${tokens[user]}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), env, {} as ExecutionContext);
  }

  it.each(["text", "voice"])("appends concurrent owner/admin %s rooms at distinct positions", async (type) => {
    const ready = deferred();
    let writers = 0;
    beforeInsert = async () => {
      if (++writers === 2) ready.resolve();
      await ready.promise;
    };
    const responses = await Promise.all([
      create({ name: "one", type }), create({ name: "two", type }, "admin"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const rooms = await Promise.all(responses.map((response) => response.json<Room>()));
    expect(rooms.map((room) => room.position).sort()).toEqual([1, 2]);
    for (const room of rooms) {
      expect(db.prepare("SELECT position FROM rooms WHERE id = ?").get(room.id)).toEqual({ position: room.position });
      if (type === "voice") expect(room.vpn_namespace).toBe(`lobby-L1-${room.id}-voice`);
      else expect(room.vpn_namespace).toBeUndefined();
    }
  });

  it("appends after a position update committed while creation was pending", async () => {
    const entered = deferred();
    const release = deferred();
    beforeInsert = async () => { entered.resolve(); await release.promise; };
    const pending = create({ name: "new", type: "text" });
    await Promise.race([entered.promise, pending.then(() => { throw new Error("create skipped INSERT"); })]);
    try {
      const moved = await worker.fetch(new Request("https://service.test/api/rooms/R1", {
        method: "PATCH", headers: { Authorization: `Bearer ${tokens.owner}`, "Content-Type": "application/json" },
        body: JSON.stringify({ position: 7 }),
      }), env, {} as ExecutionContext);
      expect(moved.status).toBe(200);
    } finally { release.resolve(); }
    const response = await pending;
    expect(response.status).toBe(201);
    expect((await response.json<Room>()).position).toBe(8);
  });

  it.each([undefined, null])("treats position %j as append and ignores other lobbies", async (position) => {
    const response = await create({ name: "new", type: "text", position });
    expect(response.status).toBe(201);
    expect((await response.json<Room>()).position).toBe(1);
  });

  it.each([0, 17, 100000])("preserves an explicit position of %i", async (position) => {
    const response = await create({ name: "new", type: "voice", position });
    expect(response.status).toBe(201);
    const room = await response.json<Room>();
    expect(room.position).toBe(position);
    expect(db.prepare("SELECT position FROM rooms WHERE id = ?").get(room.id)).toEqual({ position });
  });

  it.each([-1, 0.5, 100001, "2"])("rejects invalid position %j without creating a room", async (position) => {
    expect((await create({ name: "new", type: "text", position })).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE lobby_id = 'L1'").get()).toEqual({ n: 1 });
  });

  it.each(["member", "outsider"])("rejects creation by %s", async (user) => {
    expect((await create({ name: "new", type: "text" }, user)).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE lobby_id = 'L1'").get()).toEqual({ n: 1 });
  });

  it("starts at zero when a lobby has no existing rooms", async () => {
    db.exec("DELETE FROM rooms WHERE lobby_id = 'L1'");
    const response = await create({ name: "first", type: "text" });
    expect(response.status).toBe(201);
    expect((await response.json<Room>()).position).toBe(0);
  });
});
