import { Env, FileRecord, FilePolicy } from "./types";
import { requireAuth, generateId, json, err, checkBodySize } from "./auth";

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
    body.filename.length > 255 ||
    /[\x00-\x1f\x7f"\\]|^\.\.?$|\//.test(body.filename)
  ) {
    return err("filename contains invalid characters or has invalid length");
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

  // Storage selection: respect preference, but if it's not enabled by policy
  // walk the priority chain (user_server → lobby_server → r2). The first
  // enabled tier wins. Spec: "默认优先上传用户自己服务器、别人分享给用户的
  // 服务器、大厅服务器、服务层 R2".
  type StorageTier = "user_server" | "lobby_server" | "r2";
  const enabledFor = (tier: StorageTier): boolean => {
    if (tier === "user_server") return policy.user_server_enabled === 1;
    if (tier === "lobby_server") return policy.lobby_server_enabled === 1;
    return policy.r2_enabled === 1;
  };
  const chain: StorageTier[] = ["user_server", "lobby_server", "r2"];
  // Move preferred tier to the front; the rest of the chain is the fallback order.
  const preferred = body.storage_preference;
  const ordered: StorageTier[] = preferred
    ? [preferred, ...chain.filter((t) => t !== preferred)]
    : chain;

  let storageLocation: StorageTier | null = null;
  for (const tier of ordered) {
    if (enabledFor(tier)) { storageLocation = tier; break; }
  }
  if (!storageLocation) return err("No storage tier available for this lobby", 503);

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = policy.retain_days > 0 ? now + policy.retain_days * 86400 : null;

  let storageKey: string;
  let uploadUrl: string | null = null;

  if (storageLocation === "r2") {
    storageKey = `files/${room.lobby_id}/${roomId}/${id}/${body.filename}`;
    // Generate a pre-signed upload URL (via R2 presigned URL)
    // Note: CF R2 presigned URLs require Workers R2 + account-level API
    // For now, we'll use a direct upload proxy endpoint
    uploadUrl = `/api/rooms/${roomId}/files/${id}/upload`;
  } else {
    // For user/lobby server: return null storageKey, client handles the upload
    storageKey = `external:${storageLocation}:${id}`;
  }

  await env.DB
    .prepare(
      `INSERT INTO files (id, room_id, uploader_id, filename, size_bytes, mime_type, storage_location, storage_key, expires_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(id, roomId, auth.sub, body.filename, body.size_bytes, mimeType,
      storageLocation, storageKey, expiresAt, now)
    .run();

  return json({ id, storage_location: storageLocation, storage_key: storageKey, upload_url: uploadUrl }, 201);
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

  const body = request.body;
  if (!body) return err("No body", 400);

  // I1: enforce that the actual streamed bytes match files.size_bytes recorded
  // in initiateUpload. Without this, a client can declare 1 KiB to bypass the
  // policy.max_size_bytes check then PUT arbitrary bytes, blowing R2 quota.
  // We wrap the body in a TransformStream that counts bytes and aborts the
  // stream once the declared size is exceeded; on overrun we also delete the
  // (partially written) R2 object so we don't keep paying for it.
  const declared = file.size_bytes;
  let received = 0;
  let overflowed = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > declared) {
        overflowed = true;
        controller.error(new Error("declared size exceeded"));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  try {
    await env.FILES.put(file.storage_key, body.pipeThrough(counter), {
      httpMetadata: { contentType: file.mime_type },
    });
  } catch (e) {
    if (overflowed) {
      // Best-effort cleanup; ignore secondary errors.
      try { await env.FILES.delete(file.storage_key); } catch { /* noop */ }
      return err(`Upload exceeded declared size ${declared}`, 413);
    }
    throw e;
  }

  if (received !== declared) {
    // Underflow: client said size N but only sent M<N. Reject — the metadata
    // and quota math are otherwise wrong. Wipe R2 to avoid orphans.
    try { await env.FILES.delete(file.storage_key); } catch { /* noop */ }
    return err(`Upload short: expected ${declared}, got ${received}`, 400);
  }

  return json({ uploaded: true, key: file.storage_key, bytes: received });
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
    .prepare("SELECT * FROM files WHERE room_id = ? ORDER BY created_at DESC LIMIT 100")
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

  // K9: non-R2 storage tiers (user_server / lobby_server) never had a real
  // download path — initiateUpload writes `external:<tier>:<id>` as a marker,
  // not a URL. Returning that string as `url` was actively misleading. Phase-2
  // owns the real federated-download protocol; until then return 501 so
  // clients fall back gracefully instead of attempting a broken redirect.
  return json({ error: "non-R2 download not implemented" }, 501);
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

// runR2Cleanup deletes R2-stored files whose expires_at has passed.
// Triggered by the Workers cron (see wrangler.toml [triggers]) and exposed
// as POST /api/admin/cleanup-r2 for manual runs in development.
//
// Strategy: select up to `batchSize` expired R2 rows, delete the R2 object
// then the DB row. If the R2 delete fails we leave the DB row alone so the
// next run retries. This trades a tiny window of orphaned DB rows on R2
// outages for never silently dropping files we can't actually evict.
export async function runR2Cleanup(env: Env, batchSize = 200): Promise<{ deleted: number; failed: number }> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB
    .prepare(
      `SELECT id, storage_key FROM files
       WHERE storage_location = 'r2' AND expires_at IS NOT NULL AND expires_at <= ?
       LIMIT ?`
    )
    .bind(now, batchSize)
    .all<{ id: string; storage_key: string }>();

  let deleted = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    try {
      await env.FILES.delete(row.storage_key);
      await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(row.id).run();
      deleted++;
    } catch (e) {
      console.error(`[r2-cleanup] failed to delete ${row.id}:`, e);
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
