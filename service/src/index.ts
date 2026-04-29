import { Env } from "./types";
import { SCHEMA_SQL } from "./schema";
import { createLobby, getLobby, joinLobby, listMembers, updateMemberRole, createInvite, revokeInvite } from "./lobby";
import { getMessages, sendMessage, deleteMessage } from "./messages";
import { initiateUpload, uploadToR2, listFiles, getDownloadUrl, getFilePolicy, updateFilePolicy, runR2Cleanup } from "./files";
import { json } from "./auth";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Parse path segments
    const parts = path.split("/").filter(Boolean); // ["api","lobbies","<id>","rooms",...]

    try {
      // ── Lobbies ────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/lobbies") return createLobby(request, env);
      if (method === "GET" && parts[0] === "api" && parts[1] === "lobbies" && parts[2] && !parts[3]) {
        return getLobby(request, env, parts[2]);
      }
      if (method === "POST" && parts[1] === "lobbies" && parts[3] === "join") {
        return joinLobby(request, env, parts[2]);
      }
      if (method === "GET" && parts[1] === "lobbies" && parts[3] === "members") {
        return listMembers(request, env, parts[2]);
      }
      if (method === "PUT" && parts[1] === "lobbies" && parts[3] === "members" && parts[4]) {
        return updateMemberRole(request, env, parts[2], parts[4]);
      }
      if (method === "POST" && parts[1] === "lobbies" && parts[3] === "invites") {
        return createInvite(request, env, parts[2]);
      }
      if (method === "DELETE" && parts[1] === "lobbies" && parts[3] === "invites" && parts[4]) {
        return revokeInvite(request, env, parts[2], parts[4]);
      }

      // ── File policies ──────────────────────────────────────────────────────
      if (method === "GET" && parts[1] === "lobbies" && parts[3] === "file-policy") {
        return getFilePolicy(request, env, parts[2]);
      }
      if (method === "PUT" && parts[1] === "lobbies" && parts[3] === "file-policy") {
        return updateFilePolicy(request, env, parts[2]);
      }

      // ── Messages ───────────────────────────────────────────────────────────
      if (method === "GET" && parts[1] === "rooms" && parts[3] === "messages") {
        return getMessages(request, env, parts[2]);
      }
      if (method === "POST" && parts[1] === "rooms" && parts[3] === "messages") {
        return sendMessage(request, env, parts[2]);
      }
      if (method === "DELETE" && parts[1] === "rooms" && parts[3] === "messages" && parts[4]) {
        return deleteMessage(request, env, parts[2], parts[4]);
      }

      // ── Files ──────────────────────────────────────────────────────────────
      if (method === "POST" && parts[1] === "rooms" && parts[3] === "files" && !parts[4]) {
        return initiateUpload(request, env, parts[2]);
      }
      if (method === "PUT" && parts[1] === "rooms" && parts[3] === "files" && parts[5] === "upload") {
        return uploadToR2(request, env, parts[2], parts[4]);
      }
      if (method === "GET" && parts[1] === "rooms" && parts[3] === "files" && !parts[4]) {
        return listFiles(request, env, parts[2]);
      }
      if (method === "GET" && parts[1] === "rooms" && parts[3] === "files" && parts[5] === "download") {
        return getDownloadUrl(request, env, parts[2], parts[4]);
      }

      // ── Internal (control → service) ───────────────────────────────────────
      // Returns the user_ids of every member of the lobby that owns the room.
      // Used by control-layer getPeerConfig?room_id=... for per-room mesh
      // scoping. Authenticated via X-Internal-Token shared secret.
      if (method === "GET" && parts[1] === "internal" && parts[2] === "rooms" && parts[4] === "member-ids") {
        const token = request.headers.get("X-Internal-Token");
        if (!env.SERVICE_INTERNAL_TOKEN || token !== env.SERVICE_INTERNAL_TOKEN) {
          return json({ error: "Forbidden" }, 403);
        }
        const roomId = parts[3];
        const room = await env.DB
          .prepare("SELECT lobby_id FROM rooms WHERE id = ?")
          .bind(roomId)
          .first<{ lobby_id: string }>();
        if (!room) return json({ error: "Room not found" }, 404);
        const members = await env.DB
          .prepare("SELECT user_id FROM lobby_members WHERE lobby_id = ?")
          .bind(room.lobby_id)
          .all<{ user_id: string }>();
        return json({ user_ids: members.results.map((m) => m.user_id), room_id: roomId, lobby_id: room.lobby_id });
      }

      // ── Admin ──────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/admin/init-db") {
        if (env.ENVIRONMENT !== "development") return json({ error: "Dev only" }, 403);
        await env.DB.exec(SCHEMA_SQL);
        return json({ message: "Schema initialized" });
      }

      // Manual cleanup trigger (also runs on cron). Gated to development unless
      // an admin token matches; production should rely on the scheduled handler.
      if (method === "POST" && path === "/api/admin/cleanup-r2") {
        const adminToken = request.headers.get("X-Admin-Token");
        if (env.ENVIRONMENT !== "development" && adminToken !== env.ADMIN_TOKEN) {
          return json({ error: "Forbidden" }, 403);
        }
        const result = await runR2Cleanup(env);
        return json(result);
      }

      if (path === "/health" || path === "/") {
        return json({ status: "ok", service: "ourcord-service", ts: Date.now() });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error("Unhandled error:", e);
      // I7: development gets the message; production keeps it generic.
      const detail = (env.ENVIRONMENT ?? "production") === "development"
        ? { error: "Internal server error", detail: (e as Error).message }
        : { error: "Internal server error" };
      return json(detail, 500);
    }
  },

  // Workers cron handler. Configured via [triggers].crons in wrangler.toml.
  // Runs hourly to evict expired R2 files; the DB rows for non-R2 storage
  // backends are left alone because we don't own those bytes.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const result = await runR2Cleanup(env);
    console.log(`[cron] r2 cleanup: deleted=${result.deleted} failed=${result.failed}`);
  },
} satisfies ExportedHandler<Env>;
