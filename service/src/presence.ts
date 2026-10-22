import { checkBodySize, err, json, requireAuth } from "./auth";
import type { Env } from "./types";

export const MEMBER_PRESENCE_TTL_SECONDS = 90;

// POST /api/presence — heartbeat every lobby the authenticated user belongs
// to. voice_room_id is optional and only accepted when it is a voice room in
// one of those lobbies. Presence is account scoped: no device names or device
// identifiers are exposed to other members.
export async function updatePresence(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: { voice_room_id?: unknown } = {};
  try { body = await request.json(); } catch { /* empty body means not in voice */ }

  const rawVoiceRoomID = body.voice_room_id;
  if (rawVoiceRoomID !== undefined && rawVoiceRoomID !== null && typeof rawVoiceRoomID !== "string") {
    return err("voice_room_id must be a string");
  }
  const voiceRoomID = typeof rawVoiceRoomID === "string" ? rawVoiceRoomID.trim() : "";
  if (voiceRoomID.length > 128) return err("voice_room_id too long", 413);

  let voiceLobbyID = "";
  if (voiceRoomID) {
    const room = await env.DB.prepare(
      `SELECT r.lobby_id
         FROM rooms r
         JOIN lobby_members lm ON lm.lobby_id = r.lobby_id
        WHERE r.id = ? AND r.type = 'voice' AND lm.user_id = ?`,
    ).bind(voiceRoomID, auth.sub).first<{ lobby_id: string }>();
    if (!room) return err("voice room unavailable", 403);
    voiceLobbyID = room.lobby_id;
  }

  const now = Math.floor(Date.now() / 1000);
  // Renew timestamps without rewriting the voice-room index on every heartbeat.
  // Apply actual voice transitions in the same transaction so a failed change
  // cannot publish a fresh timestamp with an obsolete room assignment.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO lobby_presence (lobby_id, user_id, last_seen, voice_room_id)
       SELECT lm.lobby_id, lm.user_id, ?,
              CASE WHEN lm.lobby_id = ? THEN ? ELSE NULL END
         FROM lobby_members lm
        WHERE lm.user_id = ?
       ON CONFLICT(lobby_id, user_id) DO UPDATE SET
         last_seen = excluded.last_seen`,
    ).bind(now, voiceLobbyID, voiceRoomID || null, auth.sub),
    env.DB.prepare(
      `UPDATE lobby_presence
          SET voice_room_id = CASE WHEN lobby_id = ? THEN ? ELSE NULL END
        WHERE (lobby_id, user_id) IN (
          SELECT lobby_id, user_id FROM lobby_members WHERE user_id = ?
        )
          AND voice_room_id IS NOT CASE WHEN lobby_id = ? THEN ? ELSE NULL END`,
    ).bind(voiceLobbyID, voiceRoomID || null, auth.sub, voiceLobbyID, voiceRoomID || null),
  ]);

  return json({ online: true, expires_in: MEMBER_PRESENCE_TTL_SECONDS });
}

// DELETE /api/presence — best-effort immediate retirement on logout/window
// close. Crashes and power loss remain covered by the logical TTL.
export async function leavePresence(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;
  await env.DB.prepare("DELETE FROM lobby_presence WHERE user_id = ?").bind(auth.sub).run();
  return json({ online: false });
}

