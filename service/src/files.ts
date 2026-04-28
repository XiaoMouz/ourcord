import { Env, FileRecord, FilePolicy } from "./types";
import { requireAuth, generateId, json, err } from "./auth";

// POST /api/rooms/:roomId/files — initiate file upload
// Client sends metadata; server returns a pre-signed URL or storage target
export async function initiateUpload(request: Request, env: Env, roomId: string): Promise<Response> {
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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

  // Determine storage location based on policy and preference
  // Priority: user_server → lobby_server → r2
  let storageLocation: "user_server" | "lobby_server" | "r2" = "r2";
  if (body.storage_preference === "user_server" && policy.user_server_enabled) {
    storageLocation = "user_server";
  } else if (body.storage_preference === "lobby_server" && policy.lobby_server_enabled) {
    storageLocation = "lobby_server";
  } else if (!policy.r2_enabled) {
    return err("No available storage for this lobby", 503);
  }

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
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
  if (auth instanceof Response) return auth;

  const policy = await env.DB
    .prepare("SELECT * FROM file_policies WHERE lobby_id = ?")
    .bind(lobbyId).first<FilePolicy>() ?? defaultPolicy(lobbyId);

  return json({ policy });
}

// PUT /api/lobbies/:lobbyId/file-policy — update file policy (owner/admin only)
export async function updateFilePolicy(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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
