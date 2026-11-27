import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { updatePresence } from "./presence";
import { deleteRoom } from "./lobby";
import type { Env } from "./types";

const secret = "presence-index-test";

describe("indexed voice presence (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  let token: string;
  let beforeWrite: (() => void) | undefined;
  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const dir = join(__dirname, "../migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, file), "utf8"));
    db.exec(`
      INSERT INTO lobbies VALUES ('L1','friends','me',NULL,1), ('L2','friends','me',NULL,1), ('L3','other','other',NULL,1);
      INSERT INTO rooms(id,lobby_id,name,type) VALUES
        ('R1','L1','one','voice'), ('R2','L1','two','voice'), ('R3','L2','three','voice'), ('R4','L3','private','voice');
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES
        ('L1','me','owner',1), ('L2','me','owner',1), ('L1','other','member',1), ('L3','other','owner',1);
      INSERT INTO lobby_presence(lobby_id,user_id,last_seen,voice_room_id) VALUES
        ('L1','me',123,'R1'), ('L2','me',123,NULL), ('L1','other',456,'R1'), ('L3','other',456,'R4');
      CREATE TABLE voice_writes (user_id TEXT);
      CREATE TRIGGER track_voice_writes AFTER UPDATE OF voice_room_id ON lobby_presence
        BEGIN INSERT INTO voice_writes VALUES (NEW.user_id); END;
    `);
    beforeWrite = undefined;
    type Statement = { execute: () => { meta: { changes: number } } };
    env = {
      JWT_SECRET: secret, ENVIRONMENT: "production",
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) { params = values; return statement; },
            async first() { return db.prepare(sql).get(...params) ?? null; },
            execute() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
            async run() { beforeWrite?.(); return statement.execute(); },
          };
          return statement;
        },
        async batch(statements: Statement[]) {
          beforeWrite?.();
          db.exec("BEGIN");
          try {
            const results = statements.map((statement) => statement.execute());
            db.exec("COMMIT");
            return results;
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        },
      } as unknown as D1Database,
    } as Env;
    const payload = btoa(JSON.stringify({ sub: "me", exp: 9999999999 }));
    token = `${payload}.${await hmacSign(secret, payload)}`;
  });
  afterEach(() => db.close());

  const snapshot = () => db.prepare("SELECT * FROM lobby_presence ORDER BY lobby_id,user_id").all();
  const own = () => db.prepare("SELECT lobby_id,voice_room_id FROM lobby_presence WHERE user_id = 'me' ORDER BY lobby_id").all();
  const changed = () => db.prepare("SELECT COUNT(*) AS n FROM voice_writes WHERE user_id = 'me'").get();
  const request = (body: unknown) => new Request("https://service.test/api/presence", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const pulse = (voice_room_id: string) => updatePresence(request({ voice_room_id }), env);

  it("renews timestamps without touching a stable voice assignment", async () => {
    const others = db.prepare("SELECT * FROM lobby_presence WHERE user_id = 'other'").all();
    expect((await pulse("R1")).status).toBe(200);
    expect(db.prepare("SELECT last_seen FROM lobby_presence WHERE user_id = 'me'").all())
      .toEqual([{ last_seen: expect.any(Number) }, { last_seen: expect.any(Number) }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lobby_presence WHERE user_id = 'me' AND last_seen > 123").get()).toEqual({ n: 2 });
    expect(changed()).toEqual({ n: 0 });
    expect(db.prepare("SELECT * FROM lobby_presence WHERE user_id = 'other'").all()).toEqual(others);
  });

  it.each(["R2", "R3", ""])("changes only necessary assignments when switching to %j", async (room) => {
    expect((await pulse(room)).status).toBe(200);
    expect(own()).toEqual([
      { lobby_id: "L1", voice_room_id: room === "R2" ? room : null },
      { lobby_id: "L2", voice_room_id: room === "R3" ? room : null },
    ]);
    expect(changed()).toEqual({ n: room === "R3" ? 2 : 1 });
    expect((await pulse(room)).status).toBe(200);
    expect(changed()).toEqual({ n: room === "R3" ? 2 : 1 });
  });

  it("inserts missing presence with the requested voice state", async () => {
    db.exec("DELETE FROM lobby_presence WHERE user_id = 'me'");
    expect((await pulse("R3")).status).toBe(200);
    expect(own()).toEqual([{ lobby_id: "L1", voice_room_id: null }, { lobby_id: "L2", voice_room_id: "R3" }]);
    expect(changed()).toEqual({ n: 0 });
  });

  it("rolls back timestamp renewal when a voice transition fails", async () => {
    const before = snapshot();
    db.exec(`CREATE TRIGGER fail_voice_transition BEFORE UPDATE OF voice_room_id ON lobby_presence
      WHEN NEW.user_id = 'me' BEGIN SELECT RAISE(ABORT, 'voice transition failed'); END`);
    await expect(pulse("R3")).rejects.toThrow("voice transition failed");
    expect(snapshot()).toEqual(before);
  });

  it("rejects foreign rooms without renewing presence", async () => {
    const before = snapshot();
    expect((await pulse("R4")).status).toBe(403);
    expect(snapshot()).toEqual(before);
  });

  it("keeps FK deletion cleanup and indexed lookup for all room participants", async () => {
    const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM rooms WHERE id = 'R1'").all() as { detail: string }[];
    expect(plan.some((row) => /SCAN lobby_presence/.test(row.detail))).toBe(false);
    expect(plan.some((row) => /SEARCH lobby_presence.*voice_room_id=\?/.test(row.detail))).toBe(true);
    expect((await deleteRoom(new Request("https://service.test/api/rooms/R1", {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    }), env, "R1")).status).toBe(200);
    expect(db.prepare("SELECT user_id,last_seen,voice_room_id FROM lobby_presence WHERE lobby_id = 'L1' ORDER BY user_id").all())
      .toEqual([{ user_id: "me", last_seen: 123, voice_room_id: null }, { user_id: "other", last_seen: 456, voice_room_id: null }]);
    expect(db.prepare("SELECT voice_room_id FROM lobby_presence WHERE lobby_id = 'L3'").get()).toEqual({ voice_room_id: "R4" });
  });

  it("rolls back renewal if a selected room disappears before the batch", async () => {
    beforeWrite = () => db.exec("DELETE FROM rooms WHERE id = 'R3'");
    const before = snapshot();
    await expect(pulse("R3")).rejects.toThrow(/FOREIGN KEY/);
    expect(snapshot()).toEqual(before);
  });

  it("supports deploying the new heartbeat before the index migration", async () => {
    db.exec("DROP INDEX idx_lobby_presence_voice");
    expect((await pulse("R3")).status).toBe(200);
    expect(own()).toEqual([{ lobby_id: "L1", voice_room_id: null }, { lobby_id: "L2", voice_room_id: "R3" }]);
    expect((await pulse("R3")).status).toBe(200);
    expect(changed()).toEqual({ n: 2 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("adds the index to a populated old database without changing presence", () => {
    db.exec("DROP INDEX idx_lobby_presence_voice");
    const before = snapshot();
    db.exec(readFileSync(join(__dirname, "../migrations/0008_presence_voice_index.sql"), "utf8"));
    expect(snapshot()).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("DELETE FROM rooms WHERE id = 'R1'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM lobby_presence WHERE voice_room_id = 'R1'").get()).toEqual({ n: 0 });
  });

  it("commits concurrent voice changes as complete account snapshots", async () => {
    const responses = await Promise.all([pulse("R2"), pulse("R3")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const state = own();
    expect([
      [{ lobby_id: "L1", voice_room_id: "R2" }, { lobby_id: "L2", voice_room_id: null }],
      [{ lobby_id: "L1", voice_room_id: null }, { lobby_id: "L2", voice_room_id: "R3" }],
    ]).toContainEqual(state);
  });
});
