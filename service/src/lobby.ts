import { Env, Lobby, Room, LobbyMember } from "./types";
import { requireAuth, generateId, json, err } from "./auth";

// POST /api/lobbies — create a lobby
export async function createLobby(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  const userId = auth.sub;

  const body = await request.json<{ name: string; icon?: string }>();
  if (!body.name?.trim()) return err("name required");

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO lobbies (id, name, owner_id, icon, created_at) VALUES (?,?,?,?,?)")
      .bind(id, body.name.trim(), userId, body.icon ?? null, now),
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

  return json({ id, name: body.name.trim(), owner_id: userId, created_at: now }, 201);
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
  const invite = await env.DB
    .prepare(
      `SELECT * FROM lobby_invites
       WHERE code = ? AND lobby_id = ? AND revoked = 0
       AND (expires_at IS NULL OR expires_at > ?)
       AND (max_uses = 0 OR uses < max_uses)`
    )
    .bind(code, lobbyId, now)
    .first<{ code: string; uses: number; max_uses: number }>();
  if (!invite) return err("invalid, revoked, or exhausted invite", 403);

  const existing = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub)
    .first();
  if (existing) return json({ message: "Already a member" });

  // Best-effort atomic-ish increment: bump uses first, then INSERT member.
  // If the INSERT loses (race with concurrent join), the use count over-counts
  // by at most that race window — acceptable since invite quotas are coarse.
  await env.DB.batch([
    env.DB.prepare("UPDATE lobby_invites SET uses = uses + 1 WHERE code = ?").bind(code),
    env.DB.prepare("INSERT INTO lobby_members (lobby_id, user_id, role, joined_at) VALUES (?,?,?,?)")
      .bind(lobbyId, auth.sub, "member", now),
  ]);

  return json({ joined: true });
}

// POST /api/lobbies/:id/invites — owner/admin creates an invite code.
// Body: { expires_in_seconds?, max_uses? } (default: 7d expiry, single use)
export async function createInvite(request: Request, env: Env, lobbyId: string): Promise<Response> {
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
  const expiresAt = body.expires_in_seconds === 0
    ? null
    : now + (body.expires_in_seconds ?? 7 * 86400);
  const maxUses = body.max_uses ?? 1;
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

// PUT /api/lobbies/:id/members/:userId — update member role
export async function updateMemberRole(
  request: Request, env: Env, lobbyId: string, targetUserId: string
): Promise<Response> {
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

  await env.DB
    .prepare("UPDATE lobby_members SET role = ? WHERE lobby_id = ? AND user_id = ?")
    .bind(body.role, lobbyId, targetUserId)
    .run();

  return json({ updated: true });
}
