import { Env } from "./types";
import { SCHEMA_SQL } from "./schema";
import { registerPeer, getPeerConfig } from "./peers";
import { getStunServers, addStunServer } from "./stun";
import { registerRelay, getRelayMap, getBannedKeys, denyPeerOnRelay, allowPeerOnRelay } from "./relay";
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
        const rawRoomId = path.split("/")[3];
        if (!rawRoomId) return json({ error: "room_id required" }, 400);
        // I4: normalize service-room ids so case variants ("Room1" vs "room1")
        // can't fan out into separate Durable Objects. Pair ids are kept
        // verbatim (they're already lowercase hex from the client and order
        // is checked below). For service rooms, lowercase + tight charset.
        const isPair = rawRoomId.startsWith("pair:");
        const roomId = isPair ? rawRoomId : rawRoomId.toLowerCase();
        if (!isPair && !/^[a-z0-9-]{1,64}$/.test(roomId)) {
          return json({ error: "invalid room_id" }, 400);
        }

        // Authenticate before opening the WebSocket. WebSocket clients pass the
        // JWT via ?token=... query param (browsers can't send custom headers on WS).
        // Also verify that the claimed public key (?pk=) belongs to this user.
        const token = url.searchParams.get("token");
        const pk = url.searchParams.get("pk");
        if (!token || !pk) return json({ error: "token and pk required" }, 401);

        const { verifyToken, getJwtSecret } = await import("./auth");
        let claims;
        try {
          claims = await verifyToken(token, getJwtSecret(env));
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
        if (!claims) return json({ error: "invalid token" }, 401);

        const owned = await env.DB
          .prepare("SELECT 1 FROM peers WHERE public_key = ? AND user_id = ?")
          .bind(pk, claims.sub)
          .first();
        if (!owned) return json({ error: "peer not owned by user" }, 403);

        // H1: gate the SignalDO on room membership. Two roomId conventions:
        //   1. "pair:<pkA>-<pkB>" (sorted lexicographically) — 1:1 hole-punch
        //      outside any lobby. Caller's pk must be one of the two halves.
        //   2. anything else — treated as a service-layer room id; we ask the
        //      service worker for the lobby member-ids and require the caller
        //      to be in that set.
        // Without one of these checks any authenticated user could connect to
        // an arbitrary roomId DO and snoop / inject ICE signaling.
        if (roomId.startsWith("pair:")) {
          const halves = roomId.slice(5).split("-");
          if (halves.length !== 2) return json({ error: "malformed pair roomId" }, 400);
          const [a, b] = halves;
          if (a > b) return json({ error: "pair roomId must be sorted" }, 400);
          if (pk !== a && pk !== b) return json({ error: "pk not part of this pair" }, 403);
        } else {
          if (!env.SERVICE_URL || !env.SERVICE_INTERNAL_TOKEN) {
            return json({ error: "service layer not configured; room signaling unavailable" }, 503);
          }
          try {
            const r = await fetch(`${env.SERVICE_URL}/api/internal/rooms/${encodeURIComponent(roomId)}/member-ids`, {
              headers: { "X-Internal-Token": env.SERVICE_INTERNAL_TOKEN },
            });
            if (r.status === 404) return json({ error: "room not found" }, 404);
            if (!r.ok) return json({ error: `service returned ${r.status}` }, 502);
            const body = await r.json<{ user_ids: string[] }>();
            if (!body.user_ids?.includes(claims.sub)) {
              return json({ error: "not a member of this room" }, 403);
            }
          } catch (e) {
            return json({ error: `service fetch failed: ${(e as Error).message}` }, 502);
          }
        }

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
      // Per-relay denylist (relay owner only)
      if (path.startsWith("/api/relay/") && path.includes("/deny")) {
        const parts = path.split("/").filter(Boolean); // ["api","relay",":id","deny",":pk?"]
        const relayId = parts[2];
        if (method === "POST" && parts[3] === "deny" && parts.length === 4) {
          return denyPeerOnRelay(request, env, relayId);
        }
        if (method === "DELETE" && parts[3] === "deny" && parts.length === 5) {
          return allowPeerOnRelay(request, env, relayId, decodeURIComponent(parts[4]));
        }
      }

      // ── Control status ─────────────────────────────────────────────────────
      if (method === "GET" && path === "/api/control/status") {
        const now = Math.floor(Date.now() / 1000);
        const [users, peers, relays, bans] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>(),
          env.DB.prepare("SELECT COUNT(*) AS c FROM peers WHERE last_seen > ?").bind(now - 300).first<{ c: number }>(),
          env.DB.prepare("SELECT COUNT(*) AS c FROM relay_servers WHERE active = 1 AND last_heartbeat > ?").bind(now - 120).first<{ c: number }>(),
          env.DB.prepare("SELECT COUNT(*) AS c FROM bans WHERE expires_at IS NULL OR expires_at > ?").bind(now).first<{ c: number }>(),
        ]);
        return json({
          status: "ok",
          environment: env.ENVIRONMENT ?? "unknown",
          counts: {
            users: users?.c ?? 0,
            active_peers_5m: peers?.c ?? 0,
            active_relays: relays?.c ?? 0,
            active_bans: bans?.c ?? 0,
          },
          ts: Date.now(),
        });
      }

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
      // I7: only leak stack/message in development; production keeps the
      // generic 500 to avoid information disclosure.
      const detail = (env.ENVIRONMENT ?? "production") === "development"
        ? { error: "Internal server error", detail: (e as Error).message }
        : { error: "Internal server error" };
      return json(detail, 500);
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
