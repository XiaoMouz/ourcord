import { Env, Lobby, Room, LobbyMember } from "./types";
import { requireAuth, generateId, json, err } from "./auth";

// POST /api/lobbies — create a lobby
export async function createLobby(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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

// POST /api/lobbies/:id/join — join with invite (simplified: open join for now)
export async function joinLobby(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
  if (auth instanceof Response) return auth;

  const lobby = await env.DB.prepare("SELECT id FROM lobbies WHERE id = ?").bind(lobbyId).first();
  if (!lobby) return err("Lobby not found", 404);

  const existing = await env.DB
    .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
    .bind(lobbyId, auth.sub)
    .first();
  if (existing) return json({ message: "Already a member" });

  await env.DB
    .prepare("INSERT INTO lobby_members (lobby_id, user_id, role, joined_at) VALUES (?,?,?,?)")
    .bind(lobbyId, auth.sub, "member", Math.floor(Date.now() / 1000))
    .run();

  return json({ joined: true });
}

// GET /api/lobbies/:id/members — list members
export async function listMembers(request: Request, env: Env, lobbyId: string): Promise<Response> {
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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
  const auth = await requireAuth(request, env.CONTROL_INTERNAL_SECRET ?? "dev-secret-change-me");
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
