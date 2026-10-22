import { Env, Lobby, Room, LobbyMember } from "./types";
import { requireAuth, generateId, json, err, checkBodySize } from "./auth";
import { MEMBER_PRESENCE_TTL_SECONDS } from "./presence";

// GET /api/lobbies — list the authenticated user's lobby navigation model.
// A desktop client needs this aggregate to render its initial lobby/room rail
// without issuing one request per lobby. OurCord lobbies are deliberately
// small, so returning their rooms in one bounded D1 query is appropriate.
export async function listLobbies(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const rows = await env.DB.prepare(
    `SELECT l.id, l.name, l.owner_id, l.icon, l.created_at,
            lm.role, lm.joined_at
       FROM lobby_members lm
       JOIN lobbies l ON l.id = lm.lobby_id
      WHERE lm.user_id = ?
      ORDER BY lm.joined_at, l.id`,
  ).bind(auth.sub).all<Lobby & { role: LobbyMember["role"]; joined_at: number }>();

  const lobbies = rows.results ?? [];
  if (lobbies.length === 0) return json({ lobbies: [] });

  // Keep safely below D1's ~100 prepared-parameter limit. The product is for
  // small groups, but a user can join many groups over time, so batch here.
  const roomsByLobby = new Map<string, Room[]>();
  for (let offset = 0; offset < lobbies.length; offset += 90) {
    const ids = lobbies.slice(offset, offset + 90).map((l) => l.id);
    const placeholders = ids.map(() => "?").join(",");
    const rooms = await env.DB.prepare(
      `SELECT * FROM rooms WHERE lobby_id IN (${placeholders}) ORDER BY lobby_id, position, id`,
    ).bind(...ids).all<Room>();
    for (const room of rooms.results ?? []) {
      const list = roomsByLobby.get(room.lobby_id) ?? [];
      list.push(room);
      roomsByLobby.set(room.lobby_id, list);
    }
  }

  return json({
    lobbies: lobbies.map(({ role, joined_at, ...lobby }) => ({
      lobby,
      member: { role, joined_at },
      rooms: roomsByLobby.get(lobby.id) ?? [],
    })),
  });
}

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

  // D1 batch is a transaction: membership and consumption either both commit
  // or both roll back. changes() refers to the immediately preceding INSERT,
  // so duplicate requests for the same membership never spend another use.
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO lobby_members (lobby_id, user_id, role, joined_at)
       SELECT ?, ?, 'member', ?
         FROM lobby_invites
        WHERE code = ? AND lobby_id = ? AND revoked = 0
          AND (expires_at IS NULL OR expires_at > ?)
          AND (max_uses = 0 OR uses < max_uses)
       ON CONFLICT(lobby_id, user_id) DO NOTHING`,
    ).bind(lobbyId, auth.sub, now, code, lobbyId, now),
    env.DB.prepare(
      "UPDATE lobby_invites SET uses = uses + 1 WHERE code = ? AND lobby_id = ? AND changes() > 0",
    ).bind(code, lobbyId),
  ]);
  if ((inserted.meta?.changes ?? 0) === 0) {
    // Another request may have just redeemed the last use for this account.
    const joined = await env.DB.prepare(
      "SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?",
    ).bind(lobbyId, auth.sub).first();
    if (joined) return json({ message: "Already a member" });
    return err("invalid, revoked, or exhausted invite", 403);
  }

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

  const activeSince = Math.floor(Date.now() / 1000) - MEMBER_PRESENCE_TTL_SECONDS;
  const members = await env.DB
    .prepare(
      `SELECT lm.*,
              CASE WHEN lp.last_seen >= ? THEN 1 ELSE 0 END AS online,
              CASE WHEN lp.last_seen >= ? THEN lp.voice_room_id ELSE NULL END AS voice_room_id
         FROM lobby_members lm
         LEFT JOIN lobby_presence lp
           ON lp.lobby_id = lm.lobby_id AND lp.user_id = lm.user_id
        WHERE lm.lobby_id = ?
        ORDER BY online DESC, lm.joined_at`,
    )
    .bind(activeSince, activeSince, lobbyId)
    .all<Omit<LobbyMember, "online"> & { online: number }>();

  return json({ members: (members.results ?? []).map((row) => ({
    ...row,
    online: Boolean(row.online),
    voice_room_id: row.online ? row.voice_room_id ?? null : null,
  })) });
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

  let position: number | null = null;
  if (body.position !== undefined && body.position !== null) {
    if (!Number.isInteger(body.position) || body.position < 0 || body.position > 100000) {
      return err("position must be a non-negative integer");
    }
    position = body.position;
  }

  const id = generateId();
  const vpnNamespace = type === "text" ? null : `lobby-${lobbyId}-${id}-${type}`;

  // Allocate the appended position in the write: concurrent creators must not
  // both use the same MAX captured by separate reads.
  const inserted = await env.DB
    .prepare(
      `INSERT INTO rooms (id, lobby_id, name, type, position, vpn_namespace)
       VALUES (?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(position), -1) + 1 FROM rooms WHERE lobby_id = ?)), ?)
       RETURNING position`,
    )
    .bind(id, lobbyId, name, type, position, lobbyId, vpnNamespace)
    .first<{ position: number }>();
  if (!inserted) return err("Room could not be created", 500);

  const room: Room = {
    id,
    lobby_id: lobbyId,
    name,
    type: type as Room["type"],
    position: inserted.position,
    vpn_namespace: vpnNamespace ?? undefined,
  };
  return json(room, 201);
}

// PATCH /api/rooms/:roomId, or /:roomId/reorder for an atomic pair swap.
export async function updateRoom(request: Request, env: Env, roomId: string, swapPositions = false): Promise<Response> {
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

  let body: { name?: string; position?: number; swap_with?: string; expected_position?: number };
  try {
    body = await request.json<typeof body>();
  } catch {
    return err("invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return err("invalid JSON body");

  if (!swapPositions && (body.swap_with !== undefined || body.expected_position !== undefined)) {
    return err("Use the room reorder endpoint for swaps");
  }
  if (swapPositions) {
    if (typeof body.swap_with !== "string" || !body.swap_with || body.swap_with === roomId
      || typeof body.expected_position !== "number" || !Number.isInteger(body.expected_position)
      || body.expected_position < 0 || body.expected_position > 100000
      || typeof body.position !== "number" || !Number.isInteger(body.position) || body.position < 0 || body.position > 100000
      || body.name !== undefined) {
      return err("swap requires a different room and both expected positions, without name");
    }
    // Freeze both old positions before updating either row. The count guard
    // makes stale, deleted, or out-of-scope pairs a no-op in the same write.
    const swapped = await env.DB.prepare(`
      WITH pair AS MATERIALIZED (
        SELECT id, position FROM rooms
        WHERE lobby_id = ? AND type = ?
          AND ((id = ? AND position = ?) OR (id = ? AND position = ?))
      )
      UPDATE rooms SET position = (SELECT position FROM pair WHERE id <> rooms.id)
      WHERE id IN (SELECT id FROM pair) AND (SELECT COUNT(*) FROM pair) = 2
      RETURNING *
    `).bind(room.lobby_id, room.type, roomId, body.expected_position, body.swap_with, body.position)
      .all<Room>();
    const updated = swapped.results.find((row) => row.id === roomId);
    if (!updated) return err("Room order changed; refresh and try again", 409);
    return json(updated);
  }

  const updates: string[] = [];
  const values: (string | number)[] = [];
  if (body.name !== undefined) {
    const nameOrErr = validateRoomName(body.name);
    if (nameOrErr instanceof Response) return nameOrErr;
    updates.push("name = ?");
    values.push(nameOrErr);
  }

  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || body.position < 0 || body.position > 100000) {
      return err("position must be a non-negative integer");
    }
    updates.push("position = ?");
    values.push(body.position);
  }

  // Only write supplied fields: a concurrent rename must survive a reorder.
  // RETURNING also detects deletion after the authorization read.
  const updated = updates.length > 0
    ? await env.DB
      .prepare(`UPDATE rooms SET ${updates.join(", ")} WHERE id = ? RETURNING *`)
      .bind(...values, roomId)
      .first<Room>()
    : await env.DB
      .prepare("SELECT * FROM rooms WHERE id = ?")
      .bind(roomId)
      .first<Room>();
  if (!updated) return err("Room not found", 404);

  return json(updated);
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

  // Evaluate the invariant in the write itself: two owner clients may delete
  // different rooms concurrently after both have read the same room count.
  const deleted = await env.DB.prepare(
    `DELETE FROM rooms
      WHERE id = ? AND lobby_id = ?
        AND (SELECT COUNT(*) FROM rooms WHERE lobby_id = ?) > 1`,
  ).bind(roomId, room.lobby_id, room.lobby_id).run();
  if ((deleted.meta?.changes ?? 0) === 0) {
    return err("lobby must have at least one room");
  }

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
