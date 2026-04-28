import { Env } from "./types";
import { SCHEMA_SQL } from "./schema";
import { registerPeer, getPeerConfig } from "./peers";
import { getStunServers, addStunServer } from "./stun";
import { registerRelay, getRelayMap, getBannedKeys } from "./relay";
import { createBan, removeBan, checkBan } from "./ban";
import { requestOTP, verifyOTP, oauthRedirect, oauthCallback } from "./authHandler";

export { SignalDO } from "./signal";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Peer-Public-Key",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ── Auth ───────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/auth/otp/request") return requestOTP(request, env);
      if (method === "POST" && path === "/api/auth/otp/verify") return verifyOTP(request, env);
      if (method === "GET" && path.startsWith("/api/auth/oauth/")) {
        const parts = path.split("/").filter(Boolean); // ["api","auth","oauth","google"]
        const provider = parts[3];
        if (parts[4] === "callback") return oauthCallback(request, env, provider);
        return oauthRedirect(request, env, provider);
      }

      // ── Peers ──────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/peers/register") return registerPeer(request, env);
      if (method === "GET" && path === "/api/peers/config") return getPeerConfig(request, env);

      // ── Hole-punching signal (WebSocket via Durable Object) ─────────────────
      if (path.startsWith("/api/signal/")) {
        const roomId = path.split("/")[3];
        if (!roomId) return json({ error: "room_id required" }, 400);
        const doId = env.SIGNAL.idFromName(roomId);
        const doStub = env.SIGNAL.get(doId);
        return doStub.fetch(request);
      }

      // ── STUN ───────────────────────────────────────────────────────────────
      if (method === "GET" && path === "/api/stun/servers") return getStunServers(request, env);
      if (method === "POST" && path === "/api/stun/servers") return addStunServer(request, env);

      // ── Relay ──────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/relay/register") return registerRelay(request, env);
      if (method === "GET" && path === "/api/relay/map") return getRelayMap(request, env);
      if (method === "GET" && path === "/api/relay/banned-keys") return getBannedKeys(request, env);

      // ── Ban management ─────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/ban") return createBan(request, env);
      if (method === "GET" && path === "/api/ban") return checkBan(request, env);
      if (method === "DELETE" && path.startsWith("/api/ban/")) {
        const banId = path.split("/")[3];
        return removeBan(request, env, banId);
      }

      // ── Admin: init DB schema ──────────────────────────────────────────────
      if (method === "POST" && path === "/api/admin/init-db") {
        if (env.ENVIRONMENT !== "development") {
          return json({ error: "Only available in development" }, 403);
        }
        await env.DB.exec(SCHEMA_SQL);
        return json({ message: "Schema initialized" });
      }

      // ── Health check ───────────────────────────────────────────────────────
      if (path === "/health" || path === "/") {
        return json({ status: "ok", service: "ourcord-control", ts: Date.now() });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error("Unhandled error:", e);
      return json({ error: "Internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
