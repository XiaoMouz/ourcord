import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listBackends, resolveFileBackend } from "./backends";
import { hmacSign } from "./auth";
import type { Env, FilePolicy } from "./types";

describe("backend resolution using actual migrated SQL", () => {
  let db: DatabaseSync;
  let env: Env;
  const policy: FilePolicy = { lobby_id: "lobby", max_size_bytes: 1, max_total_files: 0,
    max_temp_files: 0, retain_days: 0, r2_enabled: 1, user_server_enabled: 1, lobby_server_enabled: 1 };
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const directory = join(__dirname, "../migrations");
    for (const file of readdirSync(directory).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(join(directory, file), "utf8"));
    db.exec(`INSERT INTO lobbies VALUES ('lobby','ours','user',NULL,1), ('foreign','other','other',NULL,1);
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('lobby','user','owner',1);
      INSERT INTO file_backends(id,owner_id,lobby_id,base_url,created_at,upload_secret) VALUES
      ('own-old','user',NULL,'https://files.test',1,'secret-never-returned'),
      ('own-new','user',NULL,'https://files.test',2,'secret-never-returned'),
      ('shared-old','other',NULL,'https://files.test',4,'secret-never-returned'),
      ('shared-new','other',NULL,'https://files.test',3,'secret-never-returned'),
      ('lobby-old','other','lobby','https://files.test',5,'secret-never-returned'),
      ('lobby-new','other','lobby','https://files.test',6,'secret-never-returned'),
      ('unshared','other',NULL,'https://files.test',7,'secret-never-returned'),
      ('foreign','other','foreign','https://files.test',8,'secret-never-returned');
      INSERT INTO file_backend_shares VALUES ('shared-old','user',1), ('shared-new','user',2);`);
    env = { ENVIRONMENT: "development", JWT_SECRET: "resolution-test-secret", DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        const stmt = {
          bind(...values: unknown[]) { params = values; return stmt; },
          async first() { return db.prepare(sql).get(...params) ?? null; },
          async all() { return { results: db.prepare(sql).all(...params) }; },
        };
        return stmt;
      },
    } } as unknown as Env;
  });
  afterEach(() => db.close());

  const resolve = (overrides: Partial<FilePolicy> = {}) => resolveFileBackend(env, "user", "lobby", { ...policy, ...overrides });
  const deactivate = (id: string) => db.prepare("UPDATE file_backends SET active=0 WHERE id=?").run(id);

  it("preserves tier priority and newest registration/share order, excluding inactive backends", async () => {
    for (const id of ["own-new", "own-old", "shared-new", "shared-old", "lobby-new", "lobby-old"]) {
      const result = await resolve();
      expect(result?.backend?.id).toBe(id);
      expect(result?.location).toBe(id.startsWith("lobby-") ? "lobby_server" : "user_server");
      deactivate(id);
    }
    expect(await resolve()).toEqual({ location: "r2", backend: null });
    expect(await resolve({ r2_enabled: 0 })).toBeNull();
  });

  it("preserves unhealthy cooldown and policy switches", async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare("UPDATE file_backends SET health_status='unhealthy',last_health_at=? WHERE id='own-new'").run(now);
    expect((await resolve())?.backend?.id).toBe("own-old");
    db.prepare("UPDATE file_backends SET last_health_at=? WHERE id='own-new'").run(now - 3601);
    expect((await resolve())?.backend?.id).toBe("own-new");
    expect((await resolve({ user_server_enabled: 0 }))?.backend?.id).toBe("lobby-new");
    expect((await resolve({ lobby_server_enabled: 0 }))?.backend?.id).toBe("own-new");
    expect(await resolve({ user_server_enabled: 0, lobby_server_enabled: 0 })).toEqual({ location: "r2", backend: null });
    expect(await resolve({ user_server_enabled: 0, lobby_server_enabled: 0, r2_enabled: 0 })).toBeNull();
  });

  it("lists only owned, shared and member-lobby backends without exposing capabilities", async () => {
    deactivate("own-old");
    const payload = btoa(JSON.stringify({ sub: "user", exp: 9999999999 }));
    const response = await listBackends(new Request("https://service.test/api/backends", {
      headers: { Authorization: `Bearer ${payload}.${await hmacSign(env.JWT_SECRET!, payload)}` },
    }), env);
    expect(response.status).toBe(200);
    const { backends } = await response.json<{ backends: Array<{ id: string; via: string; upload_secret?: string }> }>();
    expect(backends.map(({ id, via }) => [id, via])).toEqual([
      ["lobby-new", "lobby"], ["lobby-old", "lobby"], ["shared-old", "shared"], ["shared-new", "shared"], ["own-new", "own"],
    ]);
    expect(backends.every((backend) => !("upload_secret" in backend))).toBe(true);
  });
});
