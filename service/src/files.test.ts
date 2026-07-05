import { describe, it, expect, vi } from "vitest";
import { initiateUpload, uploadToR2, completeExternalUpload, runR2Cleanup } from "./files";
import type { Env, FilePolicy } from "./types";

// NOTE on scope: the spec for Y4 referenced a chunked upload protocol
// (initiateUpload / uploadChunk / completeUpload). The actual files.ts only
// implements a single-shot R2 proxy (initiateUpload + uploadToR2) plus a cron
// cleanup (runR2Cleanup). Tests below cover the real surface and reuse the
// existing makeDB() pattern from lobby.test.ts / messages.test.ts. Migration
// to @cloudflare/vitest-pool-workers is deferred (see task notes).

const SECRET = "test-secret-1234567890abcdef";

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const b = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeToken(sub = "u1"): Promise<string> {
  const data = b64url(JSON.stringify({ sub, email: `${sub}@x.io`, iat: 1, exp: 9999999999 }));
  return `${data}.${await hmacSign(SECRET, data)}`;
}

// Per-call scripted D1 mock — same shape as lobby.test.ts.
function makeDB(plan: { first?: unknown; run?: unknown; all?: unknown }[]): D1Database {
  let i = 0;
  const stmt = () => {
    const idx = i++;
    const step = () => plan[idx] || {};
    const s: any = {
      bind: () => s,
      first: vi.fn(async () => step().first ?? null),
      run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
      all: vi.fn(async () => step().all ?? { results: [] }),
    };
    return s as D1PreparedStatement;
  };
  return { prepare: vi.fn(() => stmt()), batch: vi.fn(), exec: vi.fn() } as unknown as D1Database;
}

// Minimal R2Bucket mock that records every put/delete/get call and returns
// canned responses keyed by storage_key.
interface R2Calls {
  put: { key: string; opts?: unknown; bytes: number }[];
  delete: string[];
  get: string[];
}
function makeR2(opts: {
  putThrows?: Error;
  objects?: Record<string, { body?: ReadableStream<Uint8Array> | null } | null>;
  deleteThrows?: Error;
} = {}): { bucket: R2Bucket; calls: R2Calls } {
  const calls: R2Calls = { put: [], delete: [], get: [] };
  const bucket: any = {
    put: vi.fn(async (key: string, body: any, putOpts?: unknown) => {
      let bytes = 0;
      if (body && typeof body.getReader === "function") {
        const reader = (body as ReadableStream<Uint8Array>).getReader();
        // Drain the stream so the TransformStream byte counter in files.ts runs
        // its transform() callback for every chunk (otherwise overflow logic
        // never triggers and the test silently passes).
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) bytes += value.byteLength;
        }
      }
      calls.put.push({ key, opts: putOpts, bytes });
      if (opts.putThrows) throw opts.putThrows;
    }),
    delete: vi.fn(async (key: string) => {
      calls.delete.push(key);
      if (opts.deleteThrows) throw opts.deleteThrows;
    }),
    get: vi.fn(async (key: string) => {
      calls.get.push(key);
      return opts.objects?.[key] ?? null;
    }),
    head: vi.fn(async () => null),
  };
  return { bucket: bucket as R2Bucket, calls };
}

const POLICY_ALL_ON: FilePolicy = {
  lobby_id: "L1",
  max_size_bytes: 1024 * 1024,
  max_total_files: 0,
  max_temp_files: 0,
  retain_days: 0,
  r2_enabled: 1,
  user_server_enabled: 1,
  lobby_server_enabled: 1,
};

function initReq(
  token: string,
  body: Record<string, unknown>,
  roomId = "R1",
): Request {
  const s = JSON.stringify(body);
  return new Request(`https://service.example/api/rooms/${roomId}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(s.length),
    },
    body: s,
  });
}

function envOf(db: D1Database, files?: R2Bucket): Env {
  return {
    ENVIRONMENT: "production",
    JWT_SECRET: SECRET,
    DB: db,
    FILES: (files ?? ({} as R2Bucket)),
    KV: {} as KVNamespace,
  } as Env;
}

describe("initiateUpload", () => {
  it("happy path (R2 storage) returns 201 with upload_url", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { lobby_id: "L1" } },         // SELECT room
      { first: { 1: 1 } },                   // membership
      { first: { ...POLICY_ALL_ON } },       // policy
      { run: { meta: { changes: 1 } } },     // INSERT files
    ]);
    const resp = await initiateUpload(
      initReq(token, {
        filename: "hello.txt",
        size_bytes: 42,
        mime_type: "text/plain",
        storage_preference: "r2",
      }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{
      id: string;
      storage_location: string;
      storage_key: string;
      upload_url: string | null;
      upload_token: string | null;
      complete_url: string | null;
    }>();
    expect(body.storage_location).toBe("r2");
    expect(body.storage_key).toMatch(/^files\/L1\/R1\/.+\/hello\.txt$/);
    expect(body.upload_url).toBe(`/api/rooms/R1/files/${body.id}/upload`);
    expect(body.upload_token).toBeNull();
    expect(body.complete_url).toBeNull();
  });

  it("happy path (registered personal backend) returns a backend upload_url", async () => {
    const token = await makeToken();
    const backend = {
      id: "B1",
      owner_id: "u1",
      lobby_id: null,
      name: "my-server",
      base_url: "https://files.me.example",
      active: 1,
      created_at: 1,
    };
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: { ...POLICY_ALL_ON } },
      { first: backend }, // resolver: own personal backend
      { run: { meta: { changes: 1 } } },
    ]);
    const resp = await initiateUpload(
      initReq(token, {
        filename: "doc.bin",
        size_bytes: 10,
        mime_type: "application/octet-stream",
        storage_preference: "user_server",
      }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{
      id: string;
      storage_location: string;
      storage_key: string;
      backend_id: string | null;
      upload_url: string | null;
      upload_token: string | null;
      complete_url: string | null;
      upload_expires_at: number | null;
    }>();
    expect(body.storage_location).toBe("user_server");
    expect(body.backend_id).toBe("B1");
    expect(body.storage_key).toBe(`files/${body.id}/doc.bin`);
    expect(body.upload_url).toBe(`https://files.me.example/files/${body.id}/doc.bin`);
    expect(body.upload_token).toMatch(/^ut_/);
    expect(body.complete_url).toBe(`/api/rooms/R1/files/${body.id}/complete`);
    expect(body.upload_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("secret-bearing backend gets a put-capability on the upload_url", async () => {
    const token = await makeToken();
    const backend = {
      id: "B2",
      owner_id: "u1",
      lobby_id: null,
      name: "secured",
      base_url: "https://files.me.example",
      upload_secret: "cap-secret-0123456789abcdef",
      active: 1,
      created_at: 1,
    };
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: { ...POLICY_ALL_ON } },
      { first: backend },
      { run: { meta: { changes: 1 } } },
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "doc.bin", size_bytes: 10, mime_type: "application/octet-stream", storage_preference: "user_server" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{ id: string; upload_url: string }>();
    expect(body.upload_url).toMatch(
      new RegExp(`^https://files\\.me\\.example/files/${body.id}/doc\\.bin\\?cap=\\d+\\.[A-Za-z0-9_-]+$`),
    );
  });

  it("keeps fixed storage priority even when storage_preference asks for R2", async () => {
    const token = await makeToken();
    const backend = {
      id: "B1",
      owner_id: "u1",
      lobby_id: null,
      name: "my-server",
      base_url: "https://files.me.example",
      active: 1,
      created_at: 1,
    };
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: { ...POLICY_ALL_ON } },
      { first: backend },
      { run: { meta: { changes: 1 } } },
    ]);
    const resp = await initiateUpload(
      initReq(token, {
        filename: "doc.bin",
        size_bytes: 10,
        mime_type: "application/octet-stream",
        storage_preference: "r2",
      }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{ storage_location: string; backend_id: string | null }>();
    expect(body.storage_location).toBe("user_server");
    expect(body.backend_id).toBe("B1");
  });

  it("falls through 自建→分享→大厅 to R2 when no backend is registered", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: { ...POLICY_ALL_ON } },
      { first: null }, // resolver: no own personal backend
      { first: null }, // resolver: nothing shared with the uploader
      { first: null }, // resolver: no lobby backend
      { run: { meta: { changes: 1 } } },
    ]);
    const resp = await initiateUpload(
      initReq(token, {
        filename: "doc.bin",
        size_bytes: 10,
        mime_type: "application/octet-stream",
        storage_preference: "user_server",
      }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{ storage_location: string; backend_id: string | null }>();
    expect(body.storage_location).toBe("r2");
    expect(body.backend_id).toBeNull();
  });

  it("returns 404 when room missing", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: null }]);
    const resp = await initiateUpload(
      initReq(token, { filename: "a", size_bytes: 1, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(404);
  });

  it("returns 403 when user is not a lobby member", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: null }, // no membership
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "a", size_bytes: 1, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(403);
  });

  it("returns 413 when size exceeds policy.max_size_bytes", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: { ...POLICY_ALL_ON, max_size_bytes: 100 } },
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "big.bin", size_bytes: 200, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(413);
  });

  it("returns 409 when temporary file quota is reached", async () => {
    const token = await makeToken();
    const policy: FilePolicy = { ...POLICY_ALL_ON, retain_days: 7, max_temp_files: 5 };
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: policy },
      { first: { n: 5 } }, // temp count >= max
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "x", size_bytes: 1, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(409);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/Temporary file quota/);
  });

  it("returns 409 when permanent file quota is reached", async () => {
    const token = await makeToken();
    const policy: FilePolicy = { ...POLICY_ALL_ON, retain_days: 0, max_total_files: 3 };
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: policy },
      { first: { n: 3 } }, // permanent count >= max
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "x", size_bytes: 1, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(409);
    const body = await resp.json<{ error: string }>();
    expect(body.error).toMatch(/Permanent file quota/);
  });

  it("falls back to application/octet-stream for an invalid mime_type (O4)", async () => {
    // Captured INSERT bind values to inspect what we actually wrote.
    const inserted: unknown[] = [];
    const db = {
      prepare: vi.fn((_sql: string) => {
        const s: any = {
          _vals: [] as unknown[],
          bind(...vals: unknown[]) { s._vals = vals; return s; },
          first: vi.fn(async () => {
            // Order: room, membership, policy
            const call = (db.prepare as any).mock.calls.length;
            if (call === 1) return { lobby_id: "L1" };
            if (call === 2) return { 1: 1 };
            if (call === 3) return { ...POLICY_ALL_ON };
            return null;
          }),
          run: vi.fn(async () => {
            inserted.push(...s._vals);
            return { meta: { changes: 1 } };
          }),
          all: vi.fn(async () => ({ results: [] })),
        };
        return s as D1PreparedStatement;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;
    const token = await makeToken();
    const resp = await initiateUpload(
      initReq(token, {
        filename: "x",
        size_bytes: 1,
        mime_type: "not a/valid mime;with stuff",
        storage_preference: "r2",
      }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    // mime_type column is the 6th param to INSERT (id, room_id, uploader_id,
    // filename, size_bytes, mime_type, ...).
    expect(inserted[5]).toBe("application/octet-stream");
  });

  it("rejects an invalid filename (K3)", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: { ...POLICY_ALL_ON } },
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "../etc/passwd", size_bytes: 1, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(400);
  });

  it("rejects non-positive or non-integer size_bytes (J6)", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: { ...POLICY_ALL_ON } },
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "x", size_bytes: -1, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(400);
  });

  it("returns 503 when no storage tier is enabled by policy", async () => {
    const token = await makeToken();
    const policy: FilePolicy = {
      ...POLICY_ALL_ON,
      r2_enabled: 0,
      user_server_enabled: 0,
      lobby_server_enabled: 0,
    };
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: policy },
    ]);
    const resp = await initiateUpload(
      initReq(token, { filename: "x", size_bytes: 1, mime_type: "text/plain" }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(503);
  });

  it("falls through disabled tiers to R2", async () => {
    const token = await makeToken();
    const policy: FilePolicy = {
      ...POLICY_ALL_ON,
      user_server_enabled: 0,           // preferred tier disabled
      lobby_server_enabled: 0,
      r2_enabled: 1,                    // only r2 left
    };
    const db = makeDB([
      { first: { lobby_id: "L1" } },
      { first: { 1: 1 } },
      { first: policy },
      { run: { meta: { changes: 1 } } },
    ]);
    const resp = await initiateUpload(
      initReq(token, {
        filename: "x.bin",
        size_bytes: 1,
        mime_type: "text/plain",
        storage_preference: "user_server", // disabled → should fall through to r2
      }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    const body = await resp.json<{ storage_location: string }>();
    expect(body.storage_location).toBe("r2");
  });
});

function completeReq(token: string, uploadToken: string, fileId = "F1", roomId = "R1"): Request {
  const body = JSON.stringify({ upload_token: uploadToken });
  return new Request(
    `https://service.example/api/rooms/${roomId}/files/${fileId}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    },
  );
}

function uploadReq(token: string, body: string, fileId = "F1", roomId = "R1"): Request {
  return new Request(
    `https://service.example/api/rooms/${roomId}/files/${fileId}/upload`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body,
    },
  );
}

const FILE_ROW = {
  id: "F1",
  room_id: "R1",
  uploader_id: "u1",
  filename: "f.txt",
  size_bytes: 5,
  mime_type: "text/plain",
  storage_location: "r2" as const,
  storage_key: "files/L1/R1/F1/f.txt",
  expires_at: null,
  created_at: 1,
};

const EXTERNAL_FILE_ROW = {
  ...FILE_ROW,
  storage_location: "user_server" as const,
  storage_key: "files/F1/f.txt",
  backend_id: "B1",
  upload_status: "pending" as const,
  upload_expires_at: 9999999999,
};

describe("uploadToR2", () => {
  it("happy path: streams body into R2.put with correct key & content-type", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: { ...FILE_ROW } }]);
    const r2 = makeR2();
    const resp = await uploadToR2(
      uploadReq(token, "hello"),
      envOf(db, r2.bucket),
      "R1",
      "F1",
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ uploaded: boolean; key: string; bytes: number }>();
    expect(body).toEqual({ uploaded: true, key: FILE_ROW.storage_key, bytes: 5 });
    expect(r2.calls.put).toHaveLength(1);
    expect(r2.calls.put[0].key).toBe(FILE_ROW.storage_key);
    expect(r2.calls.put[0].opts).toEqual({ httpMetadata: { contentType: "text/plain" } });
    expect(r2.calls.delete).toHaveLength(0);
  });

  it("returns 404 when file not found / not uploader", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: null }]);
    const r2 = makeR2();
    const resp = await uploadToR2(
      uploadReq(token, "hi"),
      envOf(db, r2.bucket),
      "R1",
      "F1",
    );
    expect(resp.status).toBe(404);
    expect(r2.calls.put).toHaveLength(0);
  });

  it("returns 400 when file is not stored in R2", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: { ...FILE_ROW, storage_location: "user_server" } }]);
    const r2 = makeR2();
    const resp = await uploadToR2(
      uploadReq(token, "hi"),
      envOf(db, r2.bucket),
      "R1",
      "F1",
    );
    expect(resp.status).toBe(400);
  });

  it("returns 413 and deletes the partial object when upload overruns declared size (I1)", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: { ...FILE_ROW, size_bytes: 3 } }]);
    const r2 = makeR2();
    const resp = await uploadToR2(
      uploadReq(token, "hello"), // 5 > 3
      envOf(db, r2.bucket),
      "R1",
      "F1",
    );
    expect(resp.status).toBe(413);
    expect(r2.calls.delete).toEqual([FILE_ROW.storage_key]);
  });

  it("returns 400 and deletes object when upload underruns declared size", async () => {
    const token = await makeToken();
    const db = makeDB([{ first: { ...FILE_ROW, size_bytes: 100 } }]);
    const r2 = makeR2();
    const resp = await uploadToR2(
      uploadReq(token, "hello"), // 5 < 100
      envOf(db, r2.bucket),
      "R1",
      "F1",
    );
    expect(resp.status).toBe(400);
    expect(r2.calls.delete).toEqual([FILE_ROW.storage_key]);
  });
});

describe("completeExternalUpload", () => {
  it("verifies backend HEAD and publishes an external upload", async () => {
    const token = await makeToken();
    const uploadToken = "upload-token";
    const db = makeDB([
      { first: { ...EXTERNAL_FILE_ROW, upload_token_hash: await sha256Hex(uploadToken) } },
      { first: { id: "B1", base_url: "https://files.me.example", active: 1 } },
      { run: { meta: { changes: 1 } } },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, headers: { "content-length": "5" } }),
    );
    try {
      const resp = await completeExternalUpload(completeReq(token, uploadToken), envOf(db), "R1", "F1");
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledWith("https://files.me.example/files/F1/f.txt", { method: "HEAD" });
      const body = await resp.json<{ uploaded: boolean; bytes: number; backend_id: string }>();
      expect(body).toEqual({ uploaded: true, bytes: 5, storage_location: "user_server", backend_id: "B1" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects invalid upload tokens", async () => {
    const token = await makeToken();
    const db = makeDB([
      { first: { ...EXTERNAL_FILE_ROW, upload_token_hash: await sha256Hex("correct-token") } },
    ]);
    const resp = await completeExternalUpload(completeReq(token, "wrong-token"), envOf(db), "R1", "F1");
    expect(resp.status).toBe(403);
  });

  it("fails and records an error when backend size does not match", async () => {
    const token = await makeToken();
    const uploadToken = "upload-token";
    const db = makeDB([
      { first: { ...EXTERNAL_FILE_ROW, upload_token_hash: await sha256Hex(uploadToken) } },
      { first: { id: "B1", base_url: "https://files.me.example", active: 1 } },
      { run: { meta: { changes: 1 } } },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, headers: { "content-length": "4" } }),
    );
    try {
      const resp = await completeExternalUpload(completeReq(token, uploadToken), envOf(db), "R1", "F1");
      expect(resp.status).toBe(409);
      const body = await resp.json<{ error: string }>();
      expect(body.error).toMatch(/size mismatch/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("quota / cleanup", () => {
  it("initiateUpload writes expires_at = now + retain_days*86400 for temporary files", async () => {
    const token = await makeToken();
    const inserted: unknown[] = [];
    const policy: FilePolicy = { ...POLICY_ALL_ON, retain_days: 2, max_temp_files: 0 };
    let call = 0;
    const db = {
      prepare: vi.fn((_sql: string) => {
        call++;
        const myCall = call;
        const s: any = {
          _vals: [] as unknown[],
          bind(...vals: unknown[]) { s._vals = vals; return s; },
          first: vi.fn(async () => {
            if (myCall === 1) return { lobby_id: "L1" };
            if (myCall === 2) return { 1: 1 };
            if (myCall === 3) return policy;
            return null;
          }),
          run: vi.fn(async () => { inserted.push(...s._vals); return { meta: { changes: 1 } }; }),
          all: vi.fn(async () => ({ results: [] })),
        };
        return s as D1PreparedStatement;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const before = Math.floor(Date.now() / 1000);
    const resp = await initiateUpload(
      initReq(token, {
        filename: "tmp.bin",
        size_bytes: 1,
        mime_type: "text/plain",
        storage_preference: "r2",
      }),
      envOf(db),
      "R1",
    );
    const after = Math.floor(Date.now() / 1000);
    expect(resp.status).toBe(201);
    // INSERT bind order: id, room_id, uploader_id, filename, size_bytes,
    // mime_type, storage_location, storage_key, backend_id, expires_at, created_at
    const expiresAt = inserted[9] as number;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 2 * 86400);
    expect(expiresAt).toBeLessThanOrEqual(after + 2 * 86400);
  });

  it("initiateUpload writes expires_at = null for permanent files", async () => {
    const token = await makeToken();
    const inserted: unknown[] = [];
    const policy: FilePolicy = { ...POLICY_ALL_ON, retain_days: 0 };
    let call = 0;
    const db = {
      prepare: vi.fn((_sql: string) => {
        call++;
        const myCall = call;
        const s: any = {
          _vals: [] as unknown[],
          bind(...vals: unknown[]) { s._vals = vals; return s; },
          first: vi.fn(async () => {
            if (myCall === 1) return { lobby_id: "L1" };
            if (myCall === 2) return { 1: 1 };
            if (myCall === 3) return policy;
            return null;
          }),
          run: vi.fn(async () => { inserted.push(...s._vals); return { meta: { changes: 1 } }; }),
          all: vi.fn(async () => ({ results: [] })),
        };
        return s as D1PreparedStatement;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const resp = await initiateUpload(
      initReq(token, {
        filename: "perma.bin",
        size_bytes: 1,
        mime_type: "text/plain",
        storage_preference: "r2",
      }),
      envOf(db),
      "R1",
    );
    expect(resp.status).toBe(201);
    // index 9 = expires_at (index 8 is backend_id, null for R2 uploads too)
    expect(inserted[9]).toBeNull();
  });

  it("runR2Cleanup deletes expired R2 objects then their D1 rows", async () => {
    const rows = [
      { id: "F1", storage_key: "files/L1/R1/F1/a" },
      { id: "F2", storage_key: "files/L1/R1/F2/b" },
    ];
    const deleteRowIds: unknown[] = [];
    let call = 0;
    const db = {
      prepare: vi.fn((sql: string) => {
        call++;
        const isSelect = sql.includes("SELECT");
        const s: any = {
          bind: (...vals: unknown[]) => { if (!isSelect) deleteRowIds.push(vals[0]); return s; },
          first: vi.fn(async () => null),
          run: vi.fn(async () => ({ meta: { changes: 1 } })),
          all: vi.fn(async () => (isSelect ? { results: rows } : { results: [] })),
        };
        return s as D1PreparedStatement;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;
    const r2 = makeR2();
    const result = await runR2Cleanup(envOf(db, r2.bucket));
    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(r2.calls.delete).toEqual([rows[0].storage_key, rows[1].storage_key]);
    expect(deleteRowIds).toEqual(["F1", "F2"]);
    void call; // touched to keep linter happy
  });

  it("runR2Cleanup counts R2 failures and skips the D1 delete for those rows", async () => {
    const rows = [{ id: "F1", storage_key: "k1" }, { id: "F2", storage_key: "k2" }];
    const dbRunCalls: string[] = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const isSelect = sql.includes("SELECT");
        const s: any = {
          _vals: [] as unknown[],
          bind: (...vals: unknown[]) => { s._vals = vals; return s; },
          first: vi.fn(async () => null),
          run: vi.fn(async () => { dbRunCalls.push(String(s._vals[0])); return { meta: { changes: 1 } }; }),
          all: vi.fn(async () => (isSelect ? { results: rows } : { results: [] })),
        };
        return s as D1PreparedStatement;
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;
    const r2 = makeR2({ deleteThrows: new Error("R2 down") });
    const result = await runR2Cleanup(envOf(db, r2.bucket));
    expect(result).toEqual({ deleted: 0, failed: 2 });
    // Both R2 deletes attempted, no D1 row deletes happened.
    expect(r2.calls.delete).toEqual(["k1", "k2"]);
    expect(dbRunCalls).toEqual([]);
  });
});
