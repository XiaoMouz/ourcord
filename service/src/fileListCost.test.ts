import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { hmacSign } from "./auth";
import { SCHEMA_SQL } from "./schema";
import type { Env, FileRecord } from "./types";

describe.each(["migrations", "development schema"])("file listing with %s", (schema) => {
  let db: DatabaseSync;
  let env: Env;
  let plans: string[];
  const seed = `
    INSERT INTO lobbies VALUES ('L1','files','owner',NULL,1);
    INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','chat'), ('R2','L1','other');
    INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('L1','owner','owner',1);
    INSERT INTO files(id,room_id,uploader_id,filename,storage_location,storage_key,created_at)
      VALUES ('legacy','R1','owner','old.txt','user_server','files/legacy/old.txt',1);
  `;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    if (schema === "migrations") {
      const dir = join(__dirname, "../migrations");
      const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      db.exec(readFileSync(join(dir, files[0]), "utf8"));
      db.exec(seed); // The legacy row predates upload_status entirely.
      for (const file of files.slice(1)) db.exec(readFileSync(join(dir, file), "utf8"));
    } else { db.exec(SCHEMA_SQL); db.exec(seed); }
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<300)
      INSERT INTO files(id,room_id,uploader_id,filename,storage_location,storage_key,created_at,upload_status)
      SELECT 'unfinished-'||i,'R1','owner','new.txt','user_server','files/new/'||i,i+1000,
        CASE i%2 WHEN 0 THEN 'pending' ELSE 'failed' END FROM n`);
    plans = [];
    env = { JWT_SECRET: "file-list-cost-secret", ENVIRONMENT: "production", DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { params = values; return statement; },
          async first() { return db.prepare(sql).get(...params) ?? null; },
          async all() {
            plans.push(...(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail));
            return { results: db.prepare(sql).all(...params) };
          },
        };
        return statement;
      },
    } as unknown as D1Database } as Env;
  });
  afterEach(() => db.close());

  async function list(room = "R1", user = "owner") {
    const payload = btoa(JSON.stringify({ sub: user, exp: 9999999999 }));
    const token = `${payload}.${await hmacSign(env.JWT_SECRET!, payload)}`;
    return worker.fetch(new Request(`https://service.test/api/rooms/${room}/files`, {
      headers: user ? { Authorization: `Bearer ${token}` } : {},
    }), env, {} as ExecutionContext);
  }

  it("returns migrated uploads while seeking past pending and failed records", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect((await response.json<{ files: FileRecord[] }>()).files.map((file) => file.id)).toEqual(["legacy"]);
    expect(plans.some((plan) => /room_id=\? AND upload_status=\?/.test(plan)), plans.join("\n")).toBe(true);
    expect(plans.some((plan) => /TEMP B-TREE/.test(plan))).toBe(false);
  });

  it("keeps the 100 newest completed files in descending order and within the requested room", async () => {
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<120)
      INSERT INTO files(id,room_id,uploader_id,filename,storage_location,storage_key,created_at)
      SELECT 'done-'||i,'R1','owner','done.txt','user_server','files/done/'||i,i+1 FROM n`);
    const response = await list();
    expect((await response.json<{ files: FileRecord[] }>()).files.map((file) => file.id))
      .toEqual(Array.from({ length: 100 }, (_, i) => `done-${120 - i}`));
    expect(await (await list("R2")).json()).toEqual({ files: [] });
  });

  it("returns empty for unfinished-only rooms", async () => {
    db.exec("DELETE FROM files WHERE id='legacy'");
    expect(await (await list()).json()).toEqual({ files: [] });
    expect(plans.some((plan) => /room_id=\? AND upload_status=\?/.test(plan)), plans.join("\n")).toBe(true);
  });

  it("rejects missing rooms and unauthorized callers before listing files", async () => {
    expect((await list("missing")).status).toBe(404);
    expect((await list("R1", "outsider")).status).toBe(403);
    expect((await list("R1", "")).status).toBe(401);
    expect(plans).toEqual([]);
  });
});
