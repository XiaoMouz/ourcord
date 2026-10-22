import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { hmacSign } from "./auth";
import { registerBackend } from "./backends";
import { completeExternalUpload, initiateUpload, listFiles, runR2Cleanup } from "./files";
import { deleteRoom } from "./lobby";
import type { Env } from "./types";

type HeadReply = { status?: number; length?: number; disconnect?: boolean };
function headGate() {
  let entered!: () => void;
  let release!: (reply: HeadReply) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const reply = new Promise<HeadReply>((resolve) => { release = resolve; });
  return { started, entered, release, reply };
}

describe("external upload finalization (real SQLite and HTTP backend)", () => {
  let db: DatabaseSync;
  let env: Env;
  let server: Server;
  let token: string;
  let now: number;
  let file: { id: string; upload_token: string; upload_url: string; upload_expires_at: number };
  let nextHead: ReturnType<typeof headGate> | undefined;
  let gates: ReturnType<typeof headGate>[];
  let headCalls: number;
  let stored: Map<string, number>;

  beforeEach(async () => {
    now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, "now").mockImplementation(() => now * 1000);
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, name), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1', 'files', 'u1', NULL, 1);
      INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','files'), ('R2','L1','other');
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('L1','u1','owner',1);
    `);
    nextHead = undefined;
    gates = [];
    headCalls = 0;
    stored = new Map();
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://backend.test").pathname;
      if (request.method === "PUT") {
        let size = 0;
        for await (const chunk of request) size += chunk.byteLength;
        stored.set(path, size);
        response.end();
        return;
      }
      headCalls++;
      const gate = nextHead;
      nextHead = undefined;
      gate?.entered();
      const reply = gate ? await gate.reply : {};
      if (reply.disconnect) {
        response.destroy();
        return;
      }
      response.writeHead(reply.status ?? (stored.has(path) ? 200 : 404), {
        "Content-Length": String(reply.length ?? stored.get(path) ?? 0),
      });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP backend did not bind a TCP port");
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
    env = {
      ENVIRONMENT: "production", JWT_SECRET: "external-upload-race-secret",
      DB: { prepare } as unknown as D1Database,
      FILES: { delete: vi.fn() } as unknown as R2Bucket,
    } as Env;
    const payload = btoa(JSON.stringify({ sub: "u1", exp: now + 3600 }));
    token = `${payload}.${await hmacSign(env.JWT_SECRET!, payload)}`;
    const registered = await registerBackend(request("/api/backends", "POST", {
      base_url: `http://127.0.0.1:${address.port}`, upload_secret: "test-backend-secret",
    }), env);
    expect(registered.status).toBe(201);
    const initiated = await initiateUpload(request("/api/rooms/R1/files", "POST", {
      filename: "file.txt", size_bytes: 5, mime_type: "text/plain",
    }), env, "R1");
    expect(initiated.status).toBe(201);
    file = await initiated.json<typeof file>();
    expect((await fetch(file.upload_url, { method: "PUT", body: "hello" })).status).toBe(200);
  });
  afterEach(async () => {
    for (const gate of gates) gate.release({});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    vi.restoreAllMocks();
  });

  function request(path: string, method = "GET", body?: unknown) {
    return new Request(`https://service.test${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  function complete(uploadToken = file.upload_token) {
    return completeExternalUpload(request(`/api/rooms/R1/files/${file.id}/complete`, "POST", {
      upload_token: uploadToken,
    }), env, "R1", file.id);
  }
  async function holdCompletion() {
    const gate = nextHead = headGate();
    gates.push(gate);
    const response = complete();
    await Promise.race([gate.started, response.then(() => { throw new Error("completion returned before HEAD"); })]);
    return { response, release: (reply: HeadReply = {}) => gate.release(reply) };
  }
  function row() {
    return db.prepare("SELECT upload_status, last_upload_error, upload_token_hash FROM files WHERE id = ?").get(file.id);
  }

  it("rejects a completion when the room is deleted during its backend HEAD", async () => {
    const pending = await holdCompletion();
    try {
      expect((await deleteRoom(request("/api/rooms/R1", "DELETE"), env, "R1")).status).toBe(200);
    } finally { pending.release(); }
    expect((await pending.response).status).toBe(409);
    expect(row()).toBeUndefined();
  });

  it("rejects a completion when cron removes the expired reservation during HEAD", async () => {
    now = file.upload_expires_at - 1;
    const pending = await holdCompletion();
    try {
      now = file.upload_expires_at;
      await runR2Cleanup(env);
      expect(row()).toBeUndefined();
    } finally { pending.release(); }
    expect((await pending.response).status).toBe(409);
    const listed = await listFiles(request("/api/rooms/R1/files"), env, "R1");
    expect(await listed.json()).toEqual({ files: [] });
    expect(env.FILES.delete).not.toHaveBeenCalled();
  });

  it("does not publish an expired reservation even when cleanup has not run yet", async () => {
    now = file.upload_expires_at - 1;
    const pending = await holdCompletion();
    now = file.upload_expires_at;
    pending.release();
    expect((await pending.response).status).toBe(409);
    expect(row()).toMatchObject({ upload_status: "pending" });
    await runR2Cleanup(env);
    expect(row()).toBeUndefined();
  });

  it("rejects the exact expiry boundary before contacting the backend", async () => {
    now = file.upload_expires_at;
    expect((await complete()).status).toBe(403);
    expect(headCalls).toBe(0);
  });

  it.each([
    ["valid", {}, 409],
    ["size mismatch", { length: 4 }, 409],
    ["backend error", { status: 503 }, 409],
    ["network failure", { disconnect: true }, 502],
  ] as const)("does not overwrite another completion with a late %s result", async (_name, reply, status) => {
    const pending = await holdCompletion();
    try {
      expect((await complete()).status).toBe(200);
      expect(row()).toMatchObject({ upload_status: "uploaded", last_upload_error: null, upload_token_hash: null });
    } finally { pending.release(reply); }
    expect((await pending.response).status).toBe(status);
    expect(row()).toMatchObject({ upload_status: "uploaded", last_upload_error: null, upload_token_hash: null });
    await runR2Cleanup(env);
    expect(row()).toMatchObject({ upload_status: "uploaded" });
  });

  it("still marks an uncompleted size mismatch as failed", async () => {
    const pending = await holdCompletion();
    pending.release({ length: 4 });
    expect((await pending.response).status).toBe(409);
    expect(row()).toMatchObject({ upload_status: "failed" });
  });

  it("rejects an invalid completion token without HEAD or a state change", async () => {
    expect((await complete("invalid-token")).status).toBe(403);
    expect(headCalls).toBe(0);
    expect(row()).toMatchObject({ upload_status: "pending" });
  });
});
