import { Env, Lobby, Room, LobbyMember } from "./types";
import { requireAuth, generateId, json, err, checkBodySize } from "./auth";

// POST /api/lobbies — create a lobby
export async function createLobby(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const userId = auth.sub;

  const body = await request.json<{ name: string; icon?: string }>();
  const name = typeof body.name === "string" ? body.name.trim() : "";
  // M2: bound name and icon to prevent oversized D1 rows.
  if (!name) return err("name required");
  if (name.length > 80) return err("name too long (max 80)", 413);
  if (body.icon !== undefined && body.icon !== null) {
    if (typeof body.icon !== "string") return err("icon must be a string");
    if (body.icon.length > 512) return err("icon too long (max 512)", 413);
  }

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO lobbies (id, name, owner_id, icon, created_at) VALUES (?,?,?,?,?)")
      .bind(id, name, userId, body.icon ?? null, now),
    // Add owner as member
    env.DB.prepare("INSERT INTO lobby_members (lobby_id, user_id, role, joined_at) VALUES (?,?,?,?)")
      .bind(id, userId, "owner", now),
    // Create default rooms
    env.DB.prepare("INSERT INTO rooms (id, lobby_id, name, type, position) VALUES (?,?,?,?,?)")
      .bind(generateId(), id, "general", "text", 0),
    env.DB.prepare("INSERT INTO rooms (id, lobby_id, name, type, position, vpn_namespace) VALUES (?,?,?,?,?,?)")
      .bind(generateId(), id, "voice", "voice", 1, `lobby-${id}-voice`),
    // Default file policy
    env.DB.prepare("INSERT INTO file_policies (lobby_id) VALUES (?)")
      .bind(id),
  ]);

  return json({ id, name, owner_id: userId, created_at: now }, 201);
}

// GET /api/lobbies/:id — get lobby info
export async function getLobby(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const lobby = await env.DB
    .prepare("SELECT * FROM lobbies WHERE id = ?")
    .bind(lobbyId)
    .first<Lobby>();
  if (!lobby) return err("Lobby not found", 404);

  // Check membership
  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub)
    .first<{ role: string }>();
  if (!member) return err("Not a member", 403);

  const rooms = await env.DB
    .prepare("SELECT * FROM rooms WHERE lobby_id = ? ORDER BY position")
    .bind(lobbyId)
    .all<Room>();

  return json({ lobby, rooms: rooms.results, member });
}

// POST /api/lobbies/:id/join — requires an invite code (?code=XXX or { code }).
// Owner/admin can grant invites via POST /api/lobbies/:id/invites.
export async function joinLobby(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  let code = url.searchParams.get("code");
  if (!code) {
    try {
      const body = await request.json<{ code?: string }>();
      code = body?.code ?? null;
    } catch { /* no body */ }
  }
  if (!code) return err("invite code required", 401);

  const lobby = await env.DB.prepare("SELECT id FROM lobbies WHERE id = ?").bind(lobbyId).first();
  if (!lobby) return err("Lobby not found", 404);

  const now = Math.floor(Date.now() / 1000);

  // Short-circuit: if already a member, no need to consume an invite use.
  const existing = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub)
    .first();
  if (existing) return json({ message: "Already a member" });

  // N1: atomic conditional UPDATE consumes one invite use only when the
  // invite is still valid AND under quota. SQLite evaluates the WHERE clause
  // and the increment as one row-level operation, so concurrent joiners that
  // raced past the SELECT (the previous design) can no longer all "win" a
  // single-use invite. meta.changes==0 means another joiner won the race or
  // the invite expired/was revoked between requests.
  const upd = await env.DB
    .prepare(
      `UPDATE lobby_invites
          SET uses = uses + 1
        WHERE code = ?
          AND lobby_id = ?
          AND revoked = 0
          AND (expires_at IS NULL OR expires_at > ?)
          AND (max_uses = 0 OR uses < max_uses)`
    )
    .bind(code, lobbyId, now)
    .run();
  if ((upd.meta?.changes ?? 0) === 0) {
    return err("invalid, revoked, or exhausted invite", 403);
  }

  // INSERT OR IGNORE so a duplicate-member race (two requests both passed
  // the existing check) doesn't 500. We've already consumed an invite use,
  // which matches the user's intent (they tried to join twice).
  await env.DB
    .prepare("INSERT OR IGNORE INTO lobby_members (lobby_id, user_id, role, joined_at) VALUES (?,?,?,?)")
    .bind(lobbyId, auth.sub, "member", now)
    .run();

  return json({ joined: true });
}

// POST /api/lobbies/:id/invites — owner/admin creates an invite code.
// Body: { expires_in_seconds?, max_uses? } (default: 7d expiry, single use)
export async function createInvite(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub).first<{ role: string }>();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return err("Insufficient permissions", 403);
  }

  let body: { expires_in_seconds?: number; max_uses?: number } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }

  const now = Math.floor(Date.now() / 1000);
  // K11: clamp expires_in_seconds to a sane window. Preserves the existing
  // "0 means no expiry" semantic, but defends against negative values
  // (instant expiry → invite born dead) and absurd futures (Number.MAX_VALUE
  // → integer overflow on the timestamp arithmetic). undefined falls back
  // to the previous 7-day default.
  const raw = body.expires_in_seconds;
  let expiresAt: number | null;
  if (raw === undefined) {
    expiresAt = now + 7 * 86400;
  } else if (raw === 0 || raw === null) {
    expiresAt = null;
  } else if (Number.isFinite(raw) && raw > 0) {
    const clamped = Math.min(Math.max(raw, 60), 365 * 86400);
    expiresAt = Math.floor(now + clamped);
  } else {
    return err("expires_in_seconds must be a non-negative finite number");
  }
  const maxUses = body.max_uses ?? 1;
  // N3: max_uses must be a non-negative integer; 0 retains the "no quota"
  // semantic. Negative or NaN inputs would either make the invite born
  // exhausted or, after binding to NULL, accidentally make it unlimited
  // depending on how SQLite coerces the OR branch.
  if (
    !Number.isInteger(maxUses) ||
    maxUses < 0 ||
    maxUses > 100000
  ) {
    return err("max_uses must be an integer between 0 and 100000");
  }
  // 8-byte URL-safe code; collisions on PRIMARY KEY would 500, accept it.
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  const code = Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");

  await env.DB
    .prepare(
      `INSERT INTO lobby_invites (code, lobby_id, created_by, created_at, expires_at, max_uses)
       VALUES (?,?,?,?,?,?)`
    )
    .bind(code, lobbyId, auth.sub, now, expiresAt, maxUses)
    .run();

  return json({ code, lobby_id: lobbyId, expires_at: expiresAt, max_uses: maxUses }, 201);
}

// DELETE /api/lobbies/:id/invites/:code — revoke
export async function revokeInvite(request: Request, env: Env, lobbyId: string, code: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub).first<{ role: string }>();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return err("Insufficient permissions", 403);
  }

  await env.DB
    .prepare("UPDATE lobby_invites SET revoked = 1 WHERE code = ? AND lobby_id = ?")
    .bind(code, lobbyId)
    .run();
  return json({ revoked: true });
}

// GET /api/lobbies/:id/members — list members
export async function listMembers(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub)
    .first();
  if (!member) return err("Not a member", 403);

  const members = await env.DB
    .prepare("SELECT * FROM lobby_members WHERE lobby_id = ? ORDER BY joined_at")
    .bind(lobbyId)
    .all<LobbyMember>();

  return json({ members: members.results });
}

// Room name policy: 1..80 chars, no ASCII control characters. Same length
// budget as lobby names so we don't blow past D1's 1MB row limit on absurd
// concatenations (e.g., when assembled into vpn_namespace).
function validateRoomName(raw: unknown): string | Response {
  if (typeof raw !== "string") return err("name required");
  const name = raw.trim();
  if (!name) return err("name required");
  if (name.length > 80) return err("name too long (max 80)", 413);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return err("name contains control characters");
  return name;
}

const ROOM_TYPES = new Set(["text", "voice", "video", "file"]);

// POST /api/lobbies/:id/rooms — owner/admin creates a room.
// vpn_namespace is auto-derived for voice/video/file so the daemon can
// parse `lobby-{lobbyId}-{roomId}-{type}` without us threading more state.
export async function createRoom(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub)
    .first<{ role: string }>();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return err("Insufficient permissions", 403);
  }

  let body: { name?: string; type?: string; position?: number };
  try {
    body = await request.json<{ name?: string; type?: string; position?: number }>();
  } catch {
    return err("invalid JSON body");
  }

  const nameOrErr = validateRoomName(body.name);
  if (nameOrErr instanceof Response) return nameOrErr;
  const name = nameOrErr;

  const type = body.type;
  if (typeof type !== "string" || !ROOM_TYPES.has(type)) {
    return err("type must be one of text, voice, video, file");
  }

  let position: number;
  if (body.position === undefined || body.position === null) {
    const row = await env.DB
      .prepare("SELECT COALESCE(MAX(position), -1) AS m FROM rooms WHERE lobby_id = ?")
      .bind(lobbyId)
      .first<{ m: number }>();
    position = (row?.m ?? -1) + 1;
  } else if (Number.isInteger(body.position) && body.position >= 0 && body.position <= 100000) {
    position = body.position;
  } else {
    return err("position must be a non-negative integer");
  }

  const id = generateId();
  const vpnNamespace = type === "text" ? null : `lobby-${lobbyId}-${id}-${type}`;

  await env.DB
    .prepare("INSERT INTO rooms (id, lobby_id, name, type, position, vpn_namespace) VALUES (?,?,?,?,?,?)")
    .bind(id, lobbyId, name, type, position, vpnNamespace)
    .run();

  const room: Room = {
    id,
    lobby_id: lobbyId,
    name,
    type: type as Room["type"],
    position,
    vpn_namespace: vpnNamespace ?? undefined,
  };
  return json(room, 201);
}

// PATCH /api/rooms/:roomId — owner/admin renames or reorders.
export async function updateRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const room = await env.DB
    .prepare("SELECT * FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<Room>();
  if (!room) return err("Room not found", 404);

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(room.lobby_id, auth.sub)
    .first<{ role: string }>();
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return err("Insufficient permissions", 403);
  }

  let body: { name?: string; position?: number };
  try {
    body = await request.json<{ name?: string; position?: number }>();
  } catch {
    return err("invalid JSON body");
  }

  let newName = room.name;
  if (body.name !== undefined) {
    const nameOrErr = validateRoomName(body.name);
    if (nameOrErr instanceof Response) return nameOrErr;
    newName = nameOrErr;
  }

  let newPosition = room.position;
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || body.position < 0 || body.position > 100000) {
      return err("position must be a non-negative integer");
    }
    newPosition = body.position;
  }

  await env.DB
    .prepare("UPDATE rooms SET name = ?, position = ? WHERE id = ?")
    .bind(newName, newPosition, roomId)
    .run();

  return json({ ...room, name: newName, position: newPosition });
}

// DELETE /api/rooms/:roomId — owner only. Refuses to delete the last room
// in a lobby so clients always have somewhere to land. FK ON DELETE CASCADE
// on messages/files cleans up child rows.
export async function deleteRoom(request: Request, env: Env, roomId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const room = await env.DB
    .prepare("SELECT lobby_id FROM rooms WHERE id = ?")
    .bind(roomId)
    .first<{ lobby_id: string }>();
  if (!room) return err("Room not found", 404);

  const member = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(room.lobby_id, auth.sub)
    .first<{ role: string }>();
  if (!member || member.role !== "owner") {
    return err("Insufficient permissions", 403);
  }

  const count = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM rooms WHERE lobby_id = ?")
    .bind(room.lobby_id)
    .first<{ c: number }>();
  if ((count?.c ?? 0) <= 1) {
    return err("lobby must have at least one room");
  }

  await env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(roomId).run();
  return json({ deleted: true });
}

// PUT /api/lobbies/:id/members/:userId — update member role
export async function updateMemberRole(
  request: Request, env: Env, lobbyId: string, targetUserId: string
): Promise<Response> {
  const tooBig = checkBodySize(request, 256);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const caller = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub)
    .first<{ role: string }>();
  if (!caller || (caller.role !== "owner" && caller.role !== "admin")) {
    return err("Insufficient permissions", 403);
  }

  const body = await request.json<{ role: "admin" | "member" | "guest" }>();
  if (!["admin", "member", "guest"].includes(body.role)) return err("Invalid role");

  // K2: load target before mutating. Without this an admin could downgrade
  // the lobby owner to `guest` and seize control, and we'd silently UPDATE
  // 0 rows for a non-member target instead of returning 404.
  const target = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, targetUserId)
    .first<{ role: string }>();
  if (!target) return err("Target user not in lobby", 404);
  if (target.role === "owner") {
    return err("cannot modify owner role", 403);
  }
  if (target.role === "admin" && caller.role !== "owner") {
    return err("only owner can change admin role", 403);
  }

  await env.DB
    .prepare("UPDATE lobby_members SET role = ? WHERE lobby_id = ? AND user_id = ?")
    .bind(body.role, lobbyId, targetUserId)
    .run();

  return json({ updated: true });
}
