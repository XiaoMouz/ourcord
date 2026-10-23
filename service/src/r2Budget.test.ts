import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { initiateUpload, runR2Cleanup, updateFilePolicy, uploadToR2 } from "./files";
import { deleteRoom } from "./lobby";
import worker from "./index";
import type { Env } from "./types";

// Execute the actual SQL and triggers, including the conditional reservation.
function d1Over(db: DatabaseSync): D1Database {
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
  return {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
}

describe("R2 budget and lifecycle (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  let token: string;
  let put: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;
  const secret = "r2-budget-test-secret";
  const migrations = join(__dirname, "../migrations");

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(migrations, file), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1','test','u1',NULL,1), ('L2','test2','u1',NULL,1);
      INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','files'), ('R2','L1','general'), ('R3','L2','files');
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('L1','u1','owner',1), ('L2','u1','owner',1);
      INSERT INTO file_policies(lobby_id,max_temp_files,user_server_enabled,lobby_server_enabled) VALUES ('L1',1,0,0), ('L2',1,0,0);
    `);
    put = vi.fn(async (_key: string, stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    });
    remove = vi.fn(async (_key: string) => {});
    env = {
      DB: d1Over(db), FILES: { put, delete: remove } as unknown as R2Bucket,
      ENVIRONMENT: "production", JWT_SECRET: secret, KV: {} as KVNamespace,
      R2_MAX_BYTES: "10", R2_MAX_FILES: "2", R2_MAX_FILE_BYTES: "10",
    };
    const payload = btoa(JSON.stringify({ sub: "u1", email: "u1@example.test", iat: 1, exp: 9999999999 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    token = `${payload}.${await hmacSign(secret, payload)}`;
  });
  afterEach(() => { db.close(); vi.useRealTimers(); });

  function req(method: string, body?: string) {
    return new Request("https://service.test/", {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
    });
  }
  function initiate(room = "R1", size = 5) {
    return initiateUpload(req("POST", JSON.stringify({ filename: "test.txt", size_bytes: size, mime_type: "text/plain" })), env, room);
  }
  function usage() {
    return db.prepare("SELECT reserved_bytes, reserved_files FROM r2_usage").get();
  }
  async function reservation(room = "R1") {
    const response = await initiate(room);
    expect(response.status).toBe(201);
    return response.json<{ id: string; storage_key: string }>();
  }

  it("reserves only the last lobby slot under concurrent requests", async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => initiate()));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(11);
    expect(usage()).toMatchObject({ reserved_files: 1, reserved_bytes: 5 });
  });

  it("enforces the operator byte budget across lobbies", async () => {
    const responses = await Promise.all([initiate("R1", 6), initiate("R3", 6)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(usage()).toMatchObject({ reserved_files: 1, reserved_bytes: 6 });
  });

  it.each([0, 30])("shares the last retention-class slot across rooms (retain_days=%s)", async (days) => {
    db.prepare("UPDATE file_policies SET retain_days = ?, max_total_files = 2, max_temp_files = 2 WHERE lobby_id = 'L1'").run(days);
    const expires = days === 0 ? null : 9999999999;
    const opposite = days === 0 ? 9999999999 : null;
    db.prepare(`INSERT INTO files(id,room_id,uploader_id,filename,storage_location,storage_key,created_at,expires_at,upload_status)
      VALUES ('same-class','R2','u1','test.txt','user_server','files/same',1,?,'pending'),
             ('other-lobby','R3','u1','test.txt','user_server','files/foreign',1,?,'uploaded')`).run(expires, expires);
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50)
      INSERT INTO files(id,room_id,uploader_id,filename,storage_location,storage_key,created_at,expires_at)
      SELECT 'opposite-'||i,'R1','u1','test.txt','user_server','files/'||i,i,? FROM n`).run(opposite);
    const responses = await Promise.all([initiate("R1", 1), initiate("R2", 1)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(usage()).toMatchObject({ reserved_files: 1, reserved_bytes: 1 });
  });

  it.each([0, 30])("rejects a lowered quota without requiring an exact historical count (retain_days=%s)", async (days) => {
    db.prepare("UPDATE file_policies SET retain_days = ?, max_total_files = 0, max_temp_files = 0 WHERE lobby_id = 'L1'").run(days);
    await reservation("R1");
    await reservation("R2");
    expect((await updateFilePolicy(req("PUT", JSON.stringify({ max_total_files: 1, max_temp_files: 1 })), env, "L1")).status).toBe(200);
    expect((await initiate("R1", 1)).status).toBe(409);
    expect(usage()).toMatchObject({ reserved_files: 2 });
  });

  it("enforces file count independently of byte capacity and lobby policies", async () => {
    env.R2_MAX_FILES = "1";
    db.exec("UPDATE file_policies SET max_temp_files = 0");
    const responses = await Promise.all([initiate("R1", 1), initiate("R3", 1)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("rejects files above the operator per-file cap even if the lobby is unlimited", async () => {
    db.exec("UPDATE file_policies SET max_size_bytes = 0");
    expect((await initiate("R1", 11)).status).toBe(413);
    expect(usage()).toMatchObject({ reserved_files: 0 });
  });

  it("zero operator capacity disables new R2 reservations", async () => {
    env.R2_MAX_BYTES = "0";
    expect((await initiate()).status).toBe(409);
    expect(put).not.toHaveBeenCalled();
  });

  it("allows only one concurrent PUT per reservation", async () => {
    const file = await reservation();
    const responses = await Promise.all([
      uploadToR2(req("PUT", "hello"), env, "R1", file.id),
      uploadToR2(req("PUT", "hello"), env, "R1", file.id),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("does not write R2 for an expired reservation", async () => {
    const file = await reservation();
    db.exec("UPDATE files SET upload_expires_at = 1");
    expect((await uploadToR2(req("PUT", "hello"), env, "R1", file.id)).status).toBe(409);
    expect(put).not.toHaveBeenCalled();
  });

  it("persists cleanup through room deletion and releases budget only after R2 deletion", async () => {
    const file = await reservation();
    expect((await deleteRoom(req("DELETE"), env, "R1")).status).toBe(200);
    expect(db.prepare("SELECT storage_key FROM r2_deletion_queue").get()).toEqual({ storage_key: file.storage_key });
    expect(usage()).toMatchObject({ reserved_files: 1, reserved_bytes: 5 });
    expect(await runR2Cleanup(env)).toEqual({ deleted: 1, failed: 0 });
    expect(remove).toHaveBeenCalledWith(file.storage_key);
    expect(usage()).toMatchObject({ reserved_files: 0, reserved_bytes: 0 });
  });

  it("also queues lobby cascades and retries R2 failures without losing reservations", async () => {
    await reservation();
    db.exec("DELETE FROM lobbies WHERE id = 'L1'");
    remove.mockRejectedValueOnce(new Error("R2 unavailable"));
    expect(await runR2Cleanup(env)).toEqual({ deleted: 0, failed: 1 });
    expect(usage()).toMatchObject({ reserved_files: 1 });
    db.exec("UPDATE r2_deletion_queue SET not_before = 0");
    expect(await runR2Cleanup(env)).toEqual({ deleted: 1, failed: 0 });
    expect(usage()).toMatchObject({ reserved_files: 0, reserved_bytes: 0 });
  });

  it("defers deletion while an upload can still finish after a room cascade", async () => {
    const file = await reservation();
    put.mockImplementationOnce(async (_key: string, stream: ReadableStream<Uint8Array>) => {
      db.exec("DELETE FROM rooms WHERE id = 'R1'");
      expect(await runR2Cleanup(env)).toEqual({ deleted: 0, failed: 0 });
      expect(remove).not.toHaveBeenCalled();
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    });
    expect((await uploadToR2(req("PUT", "hello"), env, "R1", file.id)).status).toBe(409);
    expect(usage()).toMatchObject({ reserved_files: 1 });
    db.exec("UPDATE r2_deletion_queue SET not_before = 0");
    expect(await runR2Cleanup(env)).toEqual({ deleted: 1, failed: 0 });
  });

  it("re-enqueues a late R2 completion even after an earlier cleanup released its reservation", async () => {
    const file = await reservation();
    put.mockImplementationOnce(async (_key: string, stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* consume upload before simulating a delayed acknowledgement */ }
      db.exec("DELETE FROM rooms WHERE id = 'R1'; UPDATE r2_deletion_queue SET not_before = 0");
      await runR2Cleanup(env);
      expect(usage()).toMatchObject({ reserved_files: 0 });
    });
    expect((await uploadToR2(req("PUT", "hello"), env, "R1", file.id)).status).toBe(409);
    expect(db.prepare("SELECT storage_key FROM r2_deletion_queue").get()).toEqual({ storage_key: file.storage_key });
    expect(usage()).toMatchObject({ reserved_files: 1, reserved_bytes: 5 });
    db.exec("UPDATE r2_deletion_queue SET not_before = 0");
    await runR2Cleanup(env);
    expect(usage()).toMatchObject({ reserved_files: 0 });
  });

  it("does not remove a queue generation refreshed during R2 deletion", async () => {
    await reservation();
    db.exec("DELETE FROM rooms WHERE id = 'R1'");
    remove.mockImplementationOnce(async () => {
      db.exec("UPDATE r2_deletion_queue SET not_before = not_before + 60");
    });
    await runR2Cleanup(env);
    expect(usage()).toMatchObject({ reserved_files: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM r2_deletion_queue").get()).toEqual({ n: 1 });
  });

  it("cleans expired uploaded files and abandoned permanent reservations", async () => {
    await reservation();
    db.exec("UPDATE files SET upload_status = 'uploaded', expires_at = 1");
    expect(await runR2Cleanup(env)).toEqual({ deleted: 1, failed: 0 });
    await reservation();
    db.exec("UPDATE files SET expires_at = NULL, upload_expires_at = 1");
    expect(await runR2Cleanup(env)).toEqual({ deleted: 1, failed: 0 });
    expect(usage()).toMatchObject({ reserved_files: 0, reserved_bytes: 0 });
  });

  it("cancels an unread request body if R2 rejects before consuming it", async () => {
    const file = await reservation();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    put.mockRejectedValueOnce(new Error("R2 unavailable"));
    const request = new Request("https://service.test/", {
      method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(uploadToR2(request, env, "R1", file.id)).rejects.toThrow("R2 unavailable");
    expect(cancel).toHaveBeenCalled();
    expect(db.prepare("SELECT upload_status FROM files").get()).toEqual({ upload_status: "failed" });
  });

  it("aborts stalled uploads before the deletion queue grace period ends", async () => {
    const file = await reservation();
    vi.useFakeTimers();
    const cancel = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    put.mockImplementationOnce(async (_key: string, stream: ReadableStream<Uint8Array>) => {
      started();
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
    });
    const request = new Request("https://service.test/", {
      method: "PUT", headers: { Authorization: `Bearer ${token}` },
      body: new ReadableStream<Uint8Array>({ cancel }), duplex: "half",
    } as RequestInit);
    const assertion = expect(uploadToR2(request, env, "R1", file.id)).rejects.toThrow("Upload timed out");
    await ready;
    await vi.advanceTimersByTimeAsync(600_000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT upload_status FROM files").get()).toEqual({ upload_status: "failed" });
  });

  it.each([-1, "0", 1.5, null])("rejects invalid quota value %s", async (value) => {
    expect((await updateFilePolicy(req("PUT", JSON.stringify({ max_temp_files: value })), env, "L1")).status).toBe(400);
  });

  it("keeps development init-db functional with multi-statement triggers", async () => {
    db.close();
    db = new DatabaseSync(":memory:");
    env.DB = d1Over(db);
    env.ENVIRONMENT = "development";
    const response = await worker.fetch(new Request("https://service.test/api/admin/init-db", { method: "POST" }), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toHaveLength(4);
  });

  it("migrates existing R2 reservations into usage and gives old pending rows a deadline", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      const files = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files.filter((f) => !f.startsWith("0006_"))) {
        legacy.exec(readFileSync(join(migrations, file), "utf8"));
      }
      legacy.exec(`
        INSERT INTO lobbies VALUES ('L','legacy','u1',NULL,1);
        INSERT INTO rooms(id,lobby_id,name) VALUES ('R','L','files');
        INSERT INTO files(id,room_id,uploader_id,filename,size_bytes,storage_key,created_at,upload_status)
          VALUES ('F','R','u1','old',7,'old-key',100,'pending');
      `);
      legacy.exec(readFileSync(join(migrations, "0006_r2_budget_cleanup.sql"), "utf8"));
      expect(legacy.prepare("SELECT reserved_bytes, reserved_files FROM r2_usage").get())
        .toEqual({ reserved_bytes: 7, reserved_files: 1 });
      expect(legacy.prepare("SELECT upload_expires_at FROM files").get()).toEqual({ upload_expires_at: 1900 });
    } finally { legacy.close(); }
  });
});
