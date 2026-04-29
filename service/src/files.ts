import { Env, FileRecord, FilePolicy } from "./types";
import { requireAuth, generateId, json, err } from "./auth";

// POST /api/rooms/:roomId/files — initiate file upload
// Client sends metadata; server returns a pre-signed URL or storage target
export async function initiateUpload(request: Request, env: Env, roomId: string): Promise<Response> {
  const auth = await requireAuth(request, env.JWT_SECRET ?? "dev-secret-change-me");
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

  if (!body.filename || !body.size_bytes) return err("filename and size_bytes required");

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
    .bind(id, roomId, auth.sub, body.filename, body.size_bytes, body.mime_type ?? "application/octet-stream",
      storageLocation, storageKey, expiresAt, now)
    .run();

  return json({ id, storage_location: storageLocation, storage_key: storageKey, upload_url: uploadUrl }, 201);
}

// PUT /api/rooms/:roomId/files/:fileId/upload — direct R2 upload proxy
export async function uploadToR2(
  request: Request, env: Env, roomId: string, fileId: string
): Promise<Response> {
  const auth = await requireAuth(request, env.JWT_SECRET ?? "dev-secret-change-me");
  if (auth instanceof Response) return auth;

  const file = await env.DB
    .prepare("SELECT * FROM files WHERE id = ? AND room_id = ? AND uploader_id = ?")
    .bind(fileId, roomId, auth.sub)
    .first<FileRecord>();
  if (!file) return err("File record not found or access denied", 404);
  if (file.storage_location !== "r2") return err("File not stored in R2", 400);

  const body = request.body;
  if (!body) return err("No body", 400);

  await env.FILES.put(file.storage_key, body, {
    httpMetadata: { contentType: file.mime_type },
  });

  return json({ uploaded: true, key: file.storage_key });
}

// GET /api/rooms/:roomId/files — list files in room
export async function listFiles(request: Request, env: Env, roomId: string): Promise<Response> {
  const auth = await requireAuth(request, env.JWT_SECRET ?? "dev-secret-change-me");
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
  const auth = await requireAuth(request, env.JWT_SECRET ?? "dev-secret-change-me");
  if (auth instanceof Response) return auth;

  const file = await env.DB
    .prepare("SELECT * FROM files WHERE id = ? AND room_id = ?")
    .bind(fileId, roomId)
    .first<FileRecord>();
  if (!file) return err("File not found", 404);

  if (file.storage_location === "r2") {
    // Serve directly from R2
    const obj = await env.FILES.get(file.storage_key);
    if (!obj) return err("File not found in storage", 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": file.mime_type,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // For user_server/lobby_server: the storage_key contains an external URL
  const externalUrl = file.storage_key.split(":").slice(2).join(":");
  return json({ url: externalUrl, filename: file.filename });
}

// GET /api/lobbies/:lobbyId/file-policy — get file policy
export async function getFilePolicy(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env.JWT_SECRET ?? "dev-secret-change-me");
  if (auth instanceof Response) return auth;

  const policy = await env.DB
    .prepare("SELECT * FROM file_policies WHERE lobby_id = ?")
    .bind(lobbyId).first<FilePolicy>() ?? defaultPolicy(lobbyId);

  return json({ policy });
}

// PUT /api/lobbies/:lobbyId/file-policy — update file policy (owner/admin only)
export async function updateFilePolicy(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env.JWT_SECRET ?? "dev-secret-change-me");
  if (auth instanceof Response) return auth;

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub).first<{ role: string }>();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return err("Insufficient permissions", 403);
  }

  const body = await request.json<Partial<FilePolicy>>();
  const fields = Object.entries(body)
    .filter(([k]) => k !== "lobby_id" && body[k as keyof FilePolicy] !== undefined)
    .map(([k]) => `${k} = ?`);
  const values = Object.entries(body)
    .filter(([k]) => k !== "lobby_id" && body[k as keyof FilePolicy] !== undefined)
    .map(([, v]) => v);

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
