import { Env } from "./types";
import { SCHEMA_SQL } from "./schema";
import { createLobby, listLobbies, getLobby, joinLobby, listMembers, updateMemberRole, createInvite, revokeInvite, createRoom, updateRoom, deleteRoom } from "./lobby";
import { getMessages, sendMessage, deleteMessage } from "./messages";
import { initiateUpload, uploadToR2, completeExternalUpload, listFiles, getDownloadUrl, getFilePolicy, updateFilePolicy, runR2Cleanup } from "./files";
import { registerBackend, listBackends, deactivateBackend, shareBackend, unshareBackend, checkBackendHealth, runBackendHealthChecks } from "./backends";
import { getBackendHealthSummary } from "./opsBackends";
import { json, constantTimeEqual } from "./auth";
import { verifyInternalRequest } from "./internalAuth";
import { checkRateLimit } from "./ratelimit";
import { log, newRequestId } from "./log";
import { leavePresence, updatePresence } from "./presence";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
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

    log({ event: "request.start", request_id: requestId, method, path });

    try {
      if (method === "POST" && path === "/api/presence") {
        const rl = await checkRateLimit(request, env, "presence", 120, 60);
        if (rl) return rl;
        return updatePresence(request, env);
      }
      if (method === "DELETE" && path === "/api/presence") {
        return leavePresence(request, env);
      }

      // ── Lobbies ────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/lobbies") {
        const rl = await checkRateLimit(request, env, "lobby-create", 5, 60);
        if (rl) return rl;
        return createLobby(request, env);
      }
      if (method === "GET" && path === "/api/lobbies") {
        return listLobbies(request, env);
      }
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
        const rl = await checkRateLimit(request, env, "invite-create", 10, 60);
        if (rl) return rl;
        return createInvite(request, env, parts[2]);
      }
      if (method === "DELETE" && parts[1] === "lobbies" && parts[3] === "invites" && parts[4]) {
        return revokeInvite(request, env, parts[2], parts[4]);
      }

      // ── Rooms (CRUD) ───────────────────────────────────────────────────────
      if (method === "POST" && parts[1] === "lobbies" && parts[3] === "rooms" && !parts[4]) {
        const rl = await checkRateLimit(request, env, "room-create", 10, 60);
        if (rl) return rl;
        return createRoom(request, env, parts[2]);
      }
      if (method === "PATCH" && parts[1] === "rooms" && parts[2] && !parts[3]) {
        return updateRoom(request, env, parts[2]);
      }
      if (method === "DELETE" && parts[1] === "rooms" && parts[2] && !parts[3]) {
        return deleteRoom(request, env, parts[2]);
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
        const rl = await checkRateLimit(request, env, "msg-send", 120, 60);
        if (rl) return rl;
        return sendMessage(request, env, parts[2]);
      }
      if (method === "DELETE" && parts[1] === "rooms" && parts[3] === "messages" && parts[4]) {
        return deleteMessage(request, env, parts[2], parts[4]);
      }

      // ── Files ──────────────────────────────────────────────────────────────
      if (method === "POST" && parts[1] === "rooms" && parts[3] === "files" && !parts[4]) {
        const rl = await checkRateLimit(request, env, "file-init", 30, 60);
        if (rl) return rl;
        return initiateUpload(request, env, parts[2]);
      }
      if (method === "PUT" && parts[1] === "rooms" && parts[3] === "files" && parts[5] === "upload") {
        const rl = await checkRateLimit(request, env, "file-upload", 30, 60);
        if (rl) return rl;
        return uploadToR2(request, env, parts[2], parts[4]);
      }
      if (method === "POST" && parts[1] === "rooms" && parts[3] === "files" && parts[5] === "complete") {
        const rl = await checkRateLimit(request, env, "file-complete", 30, 60);
        if (rl) return rl;
        return completeExternalUpload(request, env, parts[2], parts[4]);
      }
      if (method === "GET" && parts[1] === "rooms" && parts[3] === "files" && !parts[4]) {
        return listFiles(request, env, parts[2]);
      }
      if (method === "GET" && parts[1] === "rooms" && parts[3] === "files" && parts[5] === "download") {
        const rl = await checkRateLimit(request, env, "file-download", 120, 60);
        if (rl) return rl;
        return getDownloadUrl(request, env, parts[2], parts[4]);
      }

      // ── File backends (自建/分享/大厅 storage chain) ────────────────────────
      if (method === "POST" && parts[1] === "backends" && !parts[2]) {
        const rl = await checkRateLimit(request, env, "backend-reg", 10, 60);
        if (rl) return rl;
        return registerBackend(request, env);
      }
      if (method === "GET" && parts[1] === "backends" && !parts[2]) {
        return listBackends(request, env);
      }
      if (method === "DELETE" && parts[1] === "backends" && parts[2] && !parts[3]) {
        return deactivateBackend(request, env, parts[2]);
      }
      if (method === "POST" && parts[1] === "backends" && parts[3] === "shares" && !parts[4]) {
        return shareBackend(request, env, parts[2]);
      }
      if (method === "DELETE" && parts[1] === "backends" && parts[3] === "shares" && parts[4]) {
        return unshareBackend(request, env, parts[2], parts[4]);
      }
      if (method === "POST" && parts[1] === "backends" && parts[3] === "check" && !parts[4]) {
        const rl = await checkRateLimit(request, env, "backend-check", 30, 60);
        if (rl) return rl;
        return checkBackendHealth(request, env, parts[2]);
      }

      // ── Internal (control → service) ───────────────────────────────────────
      // Returns the user_ids of every member of the lobby that owns the room
      // or network namespace. Used by control-layer getPeerConfig?room_id=...
      // for per-network mesh scoping.
      //
      // G6: authenticated via signed short-lived headers (HMAC over
      // ts+nonce+method+path, keyed by SERVICE_INTERNAL_TOKEN) instead of the
      // former static X-Internal-Token bearer, so a captured request can't
      // become a permanent credential and can't be replayed. Contract lives in
      // internalAuth.ts (mirrored in control/src/internalAuth.ts).
      //
      // `parts[3]` is intentionally accepted as either rooms.id or
      // rooms.vpn_namespace. Product APIs keep using rooms.id for messages,
      // files, and CRUD; daemon/control may use vpn_namespace as the network
      // routing domain for voice/video/file overlays.
      if (method === "GET" && parts[1] === "internal" && parts[2] === "rooms" && parts[4] === "member-ids") {
        if (!env.SERVICE_INTERNAL_TOKEN || !(await verifyInternalRequest(request, env.SERVICE_INTERNAL_TOKEN, env.DB))) {
          return json({ error: "Forbidden" }, 403);
        }
        const roomOrNamespace = decodeURIComponent(parts[3]);
        const room = await env.DB
          .prepare("SELECT id, lobby_id, vpn_namespace FROM rooms WHERE id = ? OR vpn_namespace = ?")
          .bind(roomOrNamespace, roomOrNamespace)
          .first<{ id: string; lobby_id: string; vpn_namespace: string | null }>();
        if (!room) return json({ error: "Room not found" }, 404);
        const members = await env.DB
          .prepare("SELECT user_id FROM lobby_members WHERE lobby_id = ?")
          .bind(room.lobby_id)
          .all<{ user_id: string }>();
        return json({
          user_ids: members.results.map((m) => m.user_id),
          room_id: room.id,
          vpn_namespace: room.vpn_namespace,
          lobby_id: room.lobby_id,
        });
      }

      // Internal: file-backend health rollup for the control operator view
      // (control/src/ops.ts → /api/control/fleet). Same signed-header auth as
      // member-ids; returns aggregate counts only, never upload_secret.
      if (method === "GET" && parts[1] === "internal" && parts[2] === "backends" && parts[3] === "health-summary") {
        if (!env.SERVICE_INTERNAL_TOKEN || !(await verifyInternalRequest(request, env.SERVICE_INTERNAL_TOKEN, env.DB))) {
          return json({ error: "Forbidden" }, 403);
        }
        return json(await getBackendHealthSummary(env));
      }

      // ── Admin ──────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/admin/init-db") {
        if (env.ENVIRONMENT !== "development") return json({ error: "Dev only" }, 403);
        await applySchema(env.DB, SCHEMA_SQL);
        return json({ message: "Schema initialized" });
      }

      // Manual cleanup trigger (also runs on cron). Gated to development unless
      // an admin token matches; production should rely on the scheduled handler.
      if (method === "POST" && path === "/api/admin/cleanup-r2") {
        const adminToken = request.headers.get("X-Admin-Token");
        // J4: constant-time compare on ADMIN_TOKEN. Same threat model as
        // the internal token: a timing oracle would let an attacker recover
        // the secret byte-by-byte and then trigger admin-only operations.
        if (env.ENVIRONMENT !== "development") {
          if (!env.ADMIN_TOKEN || !adminToken || !constantTimeEqual(adminToken, env.ADMIN_TOKEN)) {
            return json({ error: "Forbidden" }, 403);
          }
        }
        const result = await runR2Cleanup(env);
        return json(result);
      }

      if (path === "/health" || path === "/") {
        return json({ status: "ok", service: "ourcord-service", ts: Date.now() });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      log({ event: "request.error", level: "error", request_id: requestId, method, path, error: String(e) });
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
    const r2 = await runR2Cleanup(env);
    const backends = await runBackendHealthChecks(env);
    log({
      event: "cron.file_maintenance",
      r2_deleted: r2.deleted,
      r2_failed: r2.failed,
      backend_checked: backends.checked,
      backend_healthy: backends.healthy,
      backend_unhealthy: backends.unhealthy,
    });
  },
} satisfies ExportedHandler<Env>;

function applySchema(db: D1Database, sql: string): Promise<unknown[]> {
  const statements = stripSQLLineComments(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return db.batch(statements.map((s) => db.prepare(s)));
}

function stripSQLLineComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}
