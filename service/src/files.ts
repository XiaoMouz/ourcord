import { Env, FileRecord, FilePolicy, FileBackend } from "./types";
import { requireAuth, generateId, json, err, checkBodySize, constantTimeEqual } from "./auth";
import { resolveFileBackend, backendFileURL } from "./backends";
import { log } from "./log";

const UPLOAD_TOKEN_TTL_SEC = 30 * 60;
// Keep below the deletion queue's 660-second grace period (migration 0006).
const R2_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function r2Budget(env: Env) {
  const read = (raw: string | undefined, fallback: number) => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid R2 budget configuration");
    return value;
  };
  return {
    bytes: read(env.R2_MAX_BYTES, 10 * 1024 ** 3),
    files: read(env.R2_MAX_FILES, 1000),
    perFile: read(env.R2_MAX_FILE_BYTES, 100 * 1024 ** 2),
  };
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateUploadToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `ut_${b64url(bytes)}`;
}

async function hashUploadToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function markUploadFailed(env: Env, fileId: string, msg: string): Promise<void> {
  // A late verifier must not demote a file another request already published.
  await env.DB
    .prepare("UPDATE files SET upload_status = 'failed', last_upload_error = ? WHERE id = ? AND upload_status = 'pending'")
    .bind(msg.slice(0, 255), fileId)
    .run();
}

function newFixedLengthStream(length: number): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  const ctor = (globalThis as unknown as {
    FixedLengthStream?: new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  }).FixedLengthStream;
  if (ctor) return new ctor(length);
  // Unit tests run in plain Node, where Cloudflare's FixedLengthStream is not
  // available. The production Worker path above still uses the fixed-length
  // primitive so R2 accepts the stream.
  return new TransformStream<Uint8Array, Uint8Array>();
}

// POST /api/rooms/:roomId/files — initiate file upload
// Client sends metadata; server returns a pre-signed URL or storage target
export async function initiateUpload(request: Request, env: Env, roomId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const room = await env.DB
    .prepare("SELECT lobby_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ lobby_id: string }>();
  if (!room) return err("Room not found", 404);

  const isMember = await env.DB
    .prepare("SELECT 1 FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(room.lobby_id, auth.sub)
    .first();
  if (!isMember) return err("Not a member", 403);

  const policy = await env.DB
    .prepare("SELECT * FROM file_policies WHERE lobby_id = ?")
    .bind(room.lobby_id)
    .first<FilePolicy>() ?? defaultPolicy(room.lobby_id);

  const body = await request.json<{
    filename: string;
    size_bytes: number;
    mime_type: string;
    storage_preference?: "user_server" | "lobby_server" | "r2";
  }>();

  if (!body.filename) return err("filename required");
  // O4: validate mime_type before it reaches D1, R2 metadata, or the
  // Content-Type response header on download. Headers() rejects raw
  // CR/LF, but unbounded/garbage values still cause MIME confusion and
  // pollute storage metadata. RFC 6838: token-charset type/subtype, no
  // parameters; cap length at 128. Invalid values silently fall back to
  // application/octet-stream so clients with quirky uploads still work.
  const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
  let mimeType = "application/octet-stream";
  if (typeof body.mime_type === "string"
      && body.mime_type.length > 0
      && body.mime_type.length <= 128
      && MIME_RE.test(body.mime_type)) {
    mimeType = body.mime_type;
  }
  // K3: validate filename charset/length before it goes into a storage_key
  // path component or a Content-Disposition header. Reject control chars,
  // quotes/backslashes (header injection / quote-escape in CD), forward
  // slashes (path traversal in storage_key), and `.`/`..` which are special
  // path segments. 1..255 bytes is the conventional filesystem ceiling.
  if (
    typeof body.filename !== "string" ||
    body.filename.length < 1 ||
    new TextEncoder().encode(body.filename).byteLength > 255 ||
    /[\x00-\x1f\x7f"\\]|^\.\.?$|\//.test(body.filename)
  ) {
    return err("filename contains invalid characters or has invalid length (max 255 UTF-8 bytes)");
  }
  // J6: positive-integer size_bytes. The previous `!body.size_bytes` check
  // accepted negative values (truthy in JS) which then sailed past the
  // max_size_bytes ceiling and ended up as a negative row in D1; the
  // streaming overflow check (I1) would then trip on the very first byte.
  // Cap declared size at 5 GiB to avoid silly memory/DB weirdness even if
  // policy.max_size_bytes is unset.
  const MAX_DECLARED_BYTES = 5 * 1024 * 1024 * 1024;
  if (
    !Number.isInteger(body.size_bytes) ||
    body.size_bytes <= 0 ||
    body.size_bytes > MAX_DECLARED_BYTES
  ) {
    return err("size_bytes must be a positive integer (max 5 GiB declared)");
  }

  // Enforce per-file size limit
  if (policy.max_size_bytes > 0 && body.size_bytes > policy.max_size_bytes) {
    return err(`File size ${body.size_bytes} exceeds limit ${policy.max_size_bytes}`, 413);
  }

  // Enforce permanent / temporary file count quotas. retain_days = 0 (kept
  // forever) counts toward max_total_files; finite retention counts toward
  // max_temp_files. A 0 in either field means unlimited.
  const isTemp = policy.retain_days > 0;
  if (isTemp && policy.max_temp_files > 0) {
    const count = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM files f JOIN rooms r ON f.room_id = r.id
         WHERE r.lobby_id = ? AND f.expires_at IS NOT NULL`
      )
      .bind(room.lobby_id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= policy.max_temp_files) {
      return err(`Temporary file quota reached (${policy.max_temp_files})`, 409);
    }
  }
  if (!isTemp && policy.max_total_files > 0) {
    const count = await env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM files f JOIN rooms r ON f.room_id = r.id
         WHERE r.lobby_id = ? AND f.expires_at IS NULL`
      )
      .bind(room.lobby_id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= policy.max_total_files) {
      return err(`Permanent file quota reached (${policy.max_total_files})`, 409);
    }
  }

  // Storage selection: walk the fixed autonomous chain 自建 → 分享 → 大厅 → R2
  // for a concretely registered backend. storage_preference is accepted for
  // wire compatibility but does not reorder the product priority chain.
  const resolved = await resolveFileBackend(env, auth.sub, room.lobby_id, policy, body.storage_preference);
  if (!resolved) return err("No storage tier available for this lobby", 503);
  const { location: storageLocation, backend } = resolved;
  const budget = r2Budget(env);
  if (storageLocation === "r2" && body.size_bytes > budget.perFile) {
    return err("File exceeds the operator R2 size limit", 413);
  }

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = policy.retain_days > 0 ? now + policy.retain_days * 86400 : null;

  let storageKey: string;
  let uploadUrl: string | null = null;
  let uploadToken: string | null = null;
  let uploadTokenHash: string | null = null;
  let uploadExpiresAt: number | null = null;

  if (storageLocation === "r2") {
    uploadExpiresAt = now + UPLOAD_TOKEN_TTL_SEC;
    storageKey = `files/${room.lobby_id}/${roomId}/${id}/${body.filename}`;
    // Generate a pre-signed upload URL (via R2 presigned URL)
    // Note: CF R2 presigned URLs require Workers R2 + account-level API
    // For now, we'll use a direct upload proxy endpoint
    uploadUrl = `/api/rooms/${roomId}/files/${id}/upload`;
  } else {
    // External backend: the client PUTs directly to the backend server at
    // {base_url}/{storage_key}; the client must then call complete_url with the
    // one-time token so service can verify size and publish the metadata.
    storageKey = `files/${id}/${body.filename}`;
    // put-cap: one hour to actually stream the bytes.
    uploadUrl = await backendFileURL(backend!, storageKey, "put", 3600);
    uploadToken = generateUploadToken();
    uploadTokenHash = await hashUploadToken(uploadToken);
    uploadExpiresAt = now + UPLOAD_TOKEN_TTL_SEC;
  }

  // Check and reserve within one SQLite statement: concurrent initiations
  // cannot all win the final slot. r2_usage includes queued deletion bytes.
  const quota = isTemp ? policy.max_temp_files : policy.max_total_files;
  const inserted = await env.DB
    .prepare(
      `INSERT INTO files (
         id, room_id, uploader_id, filename, size_bytes, mime_type,
         storage_location, storage_key, backend_id, expires_at, created_at,
         upload_status, upload_token_hash, upload_expires_at
       )
       SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
       WHERE (? = 0 OR (
         SELECT COUNT(*) FROM files f JOIN rooms r ON f.room_id = r.id
         WHERE r.lobby_id = ? AND (f.expires_at IS NOT NULL) = ?
       ) < ?)
       AND (? <> 'r2' OR EXISTS (
         SELECT 1 FROM r2_usage WHERE id = 1
         AND reserved_bytes <= ? - ? AND reserved_files < ?
       ))`
    )
    .bind(id, roomId, auth.sub, body.filename, body.size_bytes, mimeType,
      storageLocation, storageKey, backend?.id ?? null, expiresAt, now,
      "pending", uploadTokenHash, uploadExpiresAt,
      quota, room.lobby_id, isTemp ? 1 : 0, quota,
      storageLocation, budget.bytes, body.size_bytes, budget.files)
    .run();
  // D1 includes trigger writes in meta.changes (the usage reservation adds
  // another changed row), unlike SQLite's changes() for the outer statement.
  if (inserted.meta.changes === 0) return err("File quota or operator R2 budget reached", 409);

  return json({
    id,
    storage_location: storageLocation,
    storage_key: storageKey,
    backend_id: backend?.id ?? null,
    upload_url: uploadUrl,
    upload_method: "PUT",
    complete_url: storageLocation === "r2" ? null : `/api/rooms/${roomId}/files/${id}/complete`,
    upload_token: uploadToken,
    upload_expires_at: uploadExpiresAt,
  }, 201);
}

// PUT /api/rooms/:roomId/files/:fileId/upload — direct R2 upload proxy
export async function uploadToR2(
  request: Request, env: Env, roomId: string, fileId: string
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const file = await env.DB
    .prepare("SELECT * FROM files WHERE id = ? AND room_id = ? AND uploader_id = ?")
    .bind(fileId, roomId, auth.sub)
    .first<FileRecord>();
  if (!file) return err("File record not found or access denied", 404);
  if (file.storage_location !== "r2") return err("File not stored in R2", 400);
  if (file.upload_status && file.upload_status !== "pending") return err("File upload is not pending", 409);
  const now = Math.floor(Date.now() / 1000);
  if ((file.upload_expires_at ?? file.created_at + UPLOAD_TOKEN_TTL_SEC) <= now
      || (file.expires_at != null && file.expires_at <= now)) {
    return err("Upload reservation expired", 409);
  }

  const body = request.body;
  if (!body) return err("No body", 400);
  const claimed = await env.DB.prepare(
    `UPDATE files SET upload_started_at = ?
     WHERE id = ? AND upload_status = 'pending' AND upload_started_at IS NULL
       AND COALESCE(upload_expires_at, created_at + ?) > ?
       AND (expires_at IS NULL OR expires_at > ?)`,
  ).bind(now, file.id, UPLOAD_TOKEN_TTL_SEC, now, now).run();
  if (claimed.meta.changes !== 1) return err("Upload already started or reservation expired", 409);

  // I1: enforce that the actual streamed bytes match files.size_bytes recorded
  // in initiateUpload. Without this, a client can declare 1 KiB to bypass the
  // policy.max_size_bytes check then PUT arbitrary bytes, blowing R2 quota.
  // We wrap the body in a TransformStream that counts bytes and aborts the
  // stream once the declared size is exceeded; on overrun we also delete the
  // (partially written) R2 object so we don't keep paying for it.
  const declared = file.size_bytes;
  let received = 0;
  let uploadErr: "overflow" | "underflow" | null = null;
  const fixed = newFixedLengthStream(declared);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Upload timed out")), R2_UPLOAD_TIMEOUT_MS);
  const reader = body.getReader();
  const writer = fixed.writable.getWriter();
  const abort = () => {
    void reader.cancel(controller.signal.reason).catch(() => {});
    void writer.abort(controller.signal.reason).catch(() => {});
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > declared) {
          uploadErr = "overflow";
          throw new Error("declared size exceeded");
        }
        await writer.write(value);
      }
      if (received !== declared) {
        uploadErr = "underflow";
        throw new Error(`Upload short: expected ${declared}, got ${received}`);
      }
      await writer.close();
    } catch (e) {
      try { await reader.cancel(e); } catch { /* noop */ }
      try { await writer.abort(e); } catch { /* noop */ }
      throw e;
    } finally {
      reader.releaseLock();
    }
  })();

  try {
    await Promise.all([
      env.FILES.put(file.storage_key, fixed.readable, {
        httpMetadata: { contentType: file.mime_type },
      }).catch((e: unknown) => { controller.abort(e); throw e; }),
      pump,
    ]);
  } catch (e) {
    controller.abort(e);
    await pump.catch(() => {});
    if (uploadErr === "overflow") {
      // Best-effort cleanup; ignore secondary errors.
      try { await env.FILES.delete(file.storage_key); } catch { /* noop */ }
      await markUploadFailed(env, file.id, `Upload exceeded declared size ${declared}`);
      return err(`Upload exceeded declared size ${declared}`, 413);
    }
    if (uploadErr === "underflow") {
      try { await env.FILES.delete(file.storage_key); } catch { /* noop */ }
      await markUploadFailed(env, file.id, `Upload short: expected ${declared}, got ${received}`);
      return err(`Upload short: expected ${declared}, got ${received}`, 400);
    }
    await markUploadFailed(env, file.id, "R2 upload failed");
    throw e;
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", abort);
  }

  const uploaded = await env.DB
    .prepare(
      `UPDATE files
       SET upload_status = 'uploaded', uploaded_at = ?, actual_size_bytes = ?, last_upload_error = NULL
       WHERE id = ?`,
    )
    .bind(Math.floor(Date.now() / 1000), received, file.id)
    .run();
  if (uploaded.meta.changes !== 1) {
    // An R2 operation can acknowledge completion after its room was deleted.
    // Re-enqueue even if a previous cleanup already ran. Refresh the deadline
    // so a concurrent cleanup cannot delete this new queue generation.
    await env.DB.prepare(
      `INSERT INTO r2_deletion_queue (storage_key, size_bytes, not_before)
       VALUES (?, ?, ?)
       ON CONFLICT(storage_key) DO UPDATE SET not_before = excluded.not_before`,
    ).bind(file.storage_key, file.size_bytes, Math.floor(Date.now() / 1000) + 60).run();
    return err("Upload reservation removed", 409);
  }

  return json({ uploaded: true, key: file.storage_key, bytes: received });
}

// POST /api/rooms/:roomId/files/:fileId/complete — publish an external upload
// after verifying that the backend has the expected object and byte length.
export async function completeExternalUpload(
  request: Request,
  env: Env,
  roomId: string,
  fileId: string,
): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: { upload_token?: unknown };
  try {
    body = await request.json();
  } catch {
    return err("invalid JSON body");
  }
  const uploadToken = typeof body.upload_token === "string" ? body.upload_token : "";
  if (!uploadToken) return err("upload_token required");

  const file = await env.DB
    .prepare("SELECT * FROM files WHERE id = ? AND room_id = ? AND uploader_id = ?")
    .bind(fileId, roomId, auth.sub)
    .first<FileRecord>();
  if (!file) return err("File record not found or access denied", 404);
  if (file.storage_location === "r2") return err("R2 uploads complete through the upload endpoint", 400);
  if (file.upload_status !== "pending") return err("File upload is not pending", 409);
  if (!file.upload_token_hash || !file.upload_expires_at) return err("File upload token is missing", 409);
  const now = Math.floor(Date.now() / 1000);
  if (file.upload_expires_at <= now) {
    await markUploadFailed(env, file.id, "upload token expired");
    return err("upload token expired", 403);
  }
  const gotHash = await hashUploadToken(uploadToken);
  if (!constantTimeEqual(gotHash, file.upload_token_hash)) return err("invalid upload token", 403);
  if (!file.backend_id) return err("file has no registered backend", 503);

  const backend = await env.DB
    .prepare("SELECT * FROM file_backends WHERE id = ? AND active = 1")
    .bind(file.backend_id)
    .first<FileBackend>();
  if (!backend) return err("file backend is unavailable", 503);

  // get-cap for our own verification HEAD; short-lived on purpose.
  const url = await backendFileURL(backend, file.storage_key, "get", 60);
  let resp: Response;
  try {
    resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
  } catch (e) {
    const msg = `backend HEAD failed: ${String(e).slice(0, 160)}`;
    await env.DB.prepare("UPDATE files SET last_upload_error = ? WHERE id = ? AND upload_status = 'pending'").bind(msg, file.id).run();
    return err(msg, 502);
  }
  if (!resp.ok) {
    const msg = `backend HEAD returned ${resp.status}`;
    await env.DB.prepare("UPDATE files SET last_upload_error = ? WHERE id = ? AND upload_status = 'pending'").bind(msg, file.id).run();
    return err(msg, 409);
  }
  const contentLength = resp.headers.get("content-length");
  const actual = contentLength === null ? NaN : Number(contentLength);
  if (!Number.isInteger(actual) || actual !== file.size_bytes) {
    const msg = `backend size mismatch: expected ${file.size_bytes}, got ${contentLength ?? "missing"}`;
    await markUploadFailed(env, file.id, msg);
    return err(msg, 409);
  }

  const completedAt = Math.floor(Date.now() / 1000);
  const published = await env.DB
    .prepare(
      `UPDATE files
       SET upload_status = 'uploaded',
           upload_token_hash = NULL,
           upload_expires_at = NULL,
           uploaded_at = ?,
           actual_size_bytes = ?,
           last_upload_error = NULL
       WHERE id = ? AND upload_status = 'pending' AND upload_token_hash = ?
         AND upload_expires_at > ?`,
    )
    .bind(completedAt, actual, file.id, file.upload_token_hash, completedAt)
    .run();
  if (published.meta.changes === 0) {
    return err("Upload reservation removed, expired or already completed", 409);
  }
  return json({
    uploaded: true,
    bytes: actual,
    storage_location: file.storage_location,
    backend_id: backend.id,
  });
}

// GET /api/rooms/:roomId/files — list files in room
export async function listFiles(request: Request, env: Env, roomId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const room = await env.DB
    .prepare("SELECT lobby_id FROM rooms WHERE id = ?")
    .bind(roomId).first<{ lobby_id: string }>();
  if (!room) return err("Room not found", 404);

  const isMember = await env.DB
    .prepare("SELECT 1 FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(room.lobby_id, auth.sub).first();
  if (!isMember) return err("Not a member", 403);

  const files = await env.DB
    .prepare(
      `SELECT * FROM files
       WHERE room_id = ? AND upload_status = 'uploaded'
       ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(roomId)
    .all<FileRecord>();

  return json({ files: files.results });
}

// GET /api/rooms/:roomId/files/:fileId/download — get download URL
export async function getDownloadUrl(
  request: Request, env: Env, roomId: string, fileId: string
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const file = await env.DB
    .prepare("SELECT * FROM files WHERE id = ? AND room_id = ?")
    .bind(fileId, roomId)
    .first<FileRecord>();
  if (!file) return err("File not found", 404);
  if ((file.upload_status ?? "uploaded") !== "uploaded") return err("File upload is not complete", 409);

  // I2: enforce membership. listFiles already does this; getDownloadUrl was
  // missing it, so any authenticated user with a (room_id, file_id) pair could
  // read files from rooms/lobbies they don't belong to.
  const room = await env.DB
    .prepare("SELECT lobby_id FROM rooms WHERE id = ?")
    .bind(roomId).first<{ lobby_id: string }>();
  if (!room) return err("Room not found", 404);
  const isMember = await env.DB
    .prepare("SELECT 1 FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(room.lobby_id, auth.sub).first();
  if (!isMember) return err("Not a member", 403);

  if (file.storage_location === "r2") {
    // Serve directly from R2
    const obj = await env.FILES.get(file.storage_key);
    if (!obj) return err("File not found in storage", 404);
    // K3: RFC 5987 Content-Disposition. The legacy `filename="..."` token must
    // be ASCII-only and must not contain a literal `"` or `\` — escape those
    // to `_` for the fallback, and put the real (possibly UTF-8) name in
    // `filename*` per RFC 5987. Without this, a filename with `"` would let
    // a client smuggle additional CD parameters or break parsing entirely.
    const safeAscii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const headers = new Headers({
      "Content-Type": file.mime_type,
      "Access-Control-Allow-Origin": "*",
    });
    headers.set(
      "Content-Disposition",
      `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    return new Response(obj.body, { headers });
  }

  // External tiers resolve through the registered backend (backends.ts): the
  // client downloads directly from {base_url}/{storage_key}. A deactivated or
  // deleted backend yields 503 — the file may come back if the operator
  // re-activates the server, so this is unavailability, not 404.
  if (!file.backend_id) {
    return json({ error: "file has no registered backend" }, 503);
  }
  const backend = await env.DB
    .prepare("SELECT * FROM file_backends WHERE id = ? AND active = 1")
    .bind(file.backend_id)
    .first<FileBackend>();
  if (!backend) {
    return json({ error: "file backend is unavailable" }, 503);
  }
  return json({
    // get-cap: enough time for a client to start the download, not to share.
    url: await backendFileURL(backend, file.storage_key, "get", 600),
    storage_location: file.storage_location,
    backend_id: backend.id,
    filename: file.filename,
    mime_type: file.mime_type,
  });
}

// GET /api/lobbies/:lobbyId/file-policy — get file policy
export async function getFilePolicy(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const policy = await env.DB
    .prepare("SELECT * FROM file_policies WHERE lobby_id = ?")
    .bind(lobbyId).first<FilePolicy>() ?? defaultPolicy(lobbyId);

  return json({ policy });
}

// PUT /api/lobbies/:lobbyId/file-policy — update file policy (owner/admin only)
export async function updateFilePolicy(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 2 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub).first<{ role: string }>();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return err("Insufficient permissions", 403);
  }

  const body = await request.json<Partial<FilePolicy>>();
  if (!body || typeof body !== "object" || Array.isArray(body)) return err("Invalid file policy");
  // I3: column-name allowlist. Previously the SQL was built by interpolating
  // Object.keys(body) directly, letting a malicious admin/owner inject arbitrary
  // SQL via JSON keys (e.g. "max_size_bytes = 1, banned_at = 0 --"). Keep an
  // explicit, finite set of editable columns and silently drop the rest.
  const ALLOWED: readonly (keyof FilePolicy)[] = [
    "max_size_bytes",
    "max_total_files",
    "max_temp_files",
    "retain_days",
    "r2_enabled",
    "user_server_enabled",
    "lobby_server_enabled",
  ];
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const k of ALLOWED) {
    const v = body[k];
    if (v !== undefined) {
      const isFlag = k.endsWith("_enabled");
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || (isFlag && v !== 0 && v !== 1)
          || (k === "retain_days" && v > 3650)) {
        return err(`Invalid ${k}`);
      }
      fields.push(`${k} = ?`);
      values.push(v);
    }
  }

  if (!fields.length) return err("No fields to update");

  await env.DB
    .prepare(`UPDATE file_policies SET ${fields.join(", ")} WHERE lobby_id = ?`)
    .bind(...values, lobbyId)
    .run();

  return json({ updated: true });
}

// Metadata deletion durably enqueues R2 keys (including room/lobby cascades).
// Keep reservations until R2 confirms deletion; a failed delete remains queued.
export async function runR2Cleanup(env: Env, batchSize = 200): Promise<{ deleted: number; failed: number }> {
  const now = Math.floor(Date.now() / 1000);
  const limit = Number.isInteger(batchSize) ? Math.max(1, Math.min(batchSize, 200)) : 200;
  await env.DB.prepare(
    `DELETE FROM files WHERE id IN (
       SELECT id FROM files
       WHERE storage_location = 'r2' AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at LIMIT ?
     )`,
  ).bind(now, limit).run();
  await env.DB.prepare(
    `DELETE FROM files WHERE id IN (
       SELECT id FROM files WHERE upload_status = 'pending'
         AND upload_expires_at <= ? ORDER BY upload_expires_at LIMIT ?
     )`,
  ).bind(now, limit).run();
  await env.DB.prepare(
    `DELETE FROM files WHERE id IN (
       SELECT id FROM files WHERE upload_status = 'failed' LIMIT ?
     )`,
  ).bind(limit).run();

  const rows = await env.DB.prepare(
    `SELECT storage_key, not_before FROM r2_deletion_queue
     WHERE not_before <= ? ORDER BY not_before, storage_key LIMIT ?`,
  ).bind(now, limit).all<{ storage_key: string; not_before: number }>();
  let deleted = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      await env.FILES.delete(row.storage_key);
      await env.DB.prepare("DELETE FROM r2_deletion_queue WHERE storage_key = ? AND not_before = ?")
        .bind(row.storage_key, row.not_before).run();
      deleted++;
    } catch (e) {
      // Rotate failures so an unavailable object cannot starve the queue.
      await env.DB.prepare("UPDATE r2_deletion_queue SET not_before = ? WHERE storage_key = ? AND not_before = ?")
        .bind(now + 3600, row.storage_key, row.not_before).run();
      log({ event: "r2_cleanup.delete_failed", level: "error", error: String(e) });
      failed++;
    }
  }
  return { deleted, failed };
}


function defaultPolicy(lobbyId: string): FilePolicy {
  return {
    lobby_id: lobbyId,
    max_size_bytes: 104857600, // 100 MB
    max_total_files: 0,
    max_temp_files: 100,
    retain_days: 30,
    r2_enabled: 1,
    user_server_enabled: 1,
    lobby_server_enabled: 1,
  };
}
