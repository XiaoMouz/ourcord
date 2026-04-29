import { Env, Message } from "./types";
import { requireAuth, generateId, json, err, checkBodySize } from "./auth";

// GET /api/rooms/:roomId/messages?before=<id>&limit=50
export async function getMessages(request: Request, env: Env, roomId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  // Verify room membership via lobby
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

  const url = new URL(request.url);
  const before = url.searchParams.get("before"); // message id for pagination
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);

  let stmt;
  if (before) {
    stmt = env.DB
      .prepare(
        "SELECT * FROM messages WHERE room_id = ? AND created_at < (SELECT created_at FROM messages WHERE id = ?) ORDER BY created_at DESC LIMIT ?"
      )
      .bind(roomId, before, limit);
  } else {
    stmt = env.DB
      .prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?")
      .bind(roomId, limit);
  }

  const messages = await stmt.all<Message>();
  return json({ messages: messages.results.reverse() }); // return chronological order
}

// POST /api/rooms/:roomId/messages
export async function sendMessage(request: Request, env: Env, roomId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 16 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const room = await env.DB
    .prepare("SELECT lobby_id, type FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ lobby_id: string; type: string }>();
  if (!room) return err("Room not found", 404);
  if (room.type !== "text" && room.type !== "voice") return err("This room does not support text messages");

  const isMember = await env.DB
    .prepare("SELECT 1 FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(room.lobby_id, auth.sub)
    .first();
  if (!isMember) return err("Not a member", 403);

  const body = await request.json<{ content: unknown; attachments?: unknown }>();

  const MAX_CONTENT_BYTES = 8 * 1024;
  const MAX_ATTACHMENTS = 10;
  const MAX_ATTACHMENT_LEN = 256;

  // M5: content must be a string when present (else ?.trim() throws → 500).
  let content = "";
  if (body.content !== undefined && body.content !== null) {
    if (typeof body.content !== "string") return err("content must be a string");
    if (new TextEncoder().encode(body.content).byteLength > MAX_CONTENT_BYTES) {
      return err("content too large", 413);
    }
    content = body.content.trim();
  }

  // M3: each attachment must be a short string (file id / URL ref).
  let attachmentsJSON: string | null = null;
  if (body.attachments !== undefined && body.attachments !== null) {
    if (!Array.isArray(body.attachments)) return err("attachments must be an array");
    if (body.attachments.length > MAX_ATTACHMENTS) return err("too many attachments", 400);
    const cleaned: string[] = [];
    for (const a of body.attachments) {
      if (typeof a !== "string") return err("attachment must be a string");
      const t = a.trim();
      if (!t) return err("attachment must not be empty");
      if (t.length > MAX_ATTACHMENT_LEN) return err("attachment too long", 413);
      cleaned.push(t);
    }
    if (cleaned.length > 0) attachmentsJSON = JSON.stringify(cleaned);
  }

  if (!content && !attachmentsJSON) return err("content required");

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);

  await env.DB
    .prepare("INSERT INTO messages (id, room_id, user_id, content, attachments, created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, roomId, auth.sub, content, attachmentsJSON, now)
    .run();

  return json({ id, room_id: roomId, user_id: auth.sub, content, created_at: now }, 201);
}

// DELETE /api/rooms/:roomId/messages/:msgId
export async function deleteMessage(
  request: Request, env: Env, roomId: string, msgId: string
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const msg = await env.DB
    .prepare("SELECT user_id, room_id FROM messages WHERE id = ?")
    .bind(msgId)
    .first<{ user_id: string; room_id: string }>();
  if (!msg || msg.room_id !== roomId) return err("Message not found", 404);

  // Allow deletion by message owner or lobby admin/owner
  if (msg.user_id !== auth.sub) {
    const room = await env.DB
      .prepare("SELECT lobby_id FROM rooms WHERE id = ?")
      .bind(roomId)
      .first<{ lobby_id: string }>();
    const member = await env.DB
      .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
      .bind(room?.lobby_id, auth.sub)
      .first<{ role: string }>();
    if (!member || (member.role !== "admin" && member.role !== "owner")) {
      return err("Insufficient permissions", 403);
    }
  }

  await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(msgId).run();
  return json({ deleted: true });
}
