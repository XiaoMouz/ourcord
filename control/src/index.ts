import { Env } from "./types";
import { signInternalHeaders } from "./internalAuth";
import { registerPeer, getPeerConfig, lookupPeers, reportPeerConnectivity } from "./peers";
import { getStunServers, addStunServer } from "./stun";
import { registerRelay, getRelayMap, getBannedKeys, denyPeerOnRelay, allowPeerOnRelay } from "./relay";
import { createBan, removeBan, checkBan } from "./ban";
import { getFleetStatus } from "./ops";
import { requestOTP, verifyOTP, oauthRedirect, oauthCallback, requestDesktopMagic, confirmDesktopMagicPage, confirmDesktopMagic, exchangeDesktopCode } from "./authHandler";
import { getMe, updateMe, lookupProfiles } from "./profile";
import { enrollDevice, exchangeDeviceToken, listDevices, revokeDevice } from "./devices";
import { checkRateLimit } from "./ratelimit";
import { log, newRequestId } from "./log";
import { json as jsonBase } from "./auth";

export { SignalDO } from "./signal";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = newRequestId();
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

    log({ event: "request.start", request_id: requestId, method, path });

    try {
      // ── Auth ───────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/auth/otp/request") {
        const rl = await checkRateLimit(request, env, "otp-req", 5, 60);
        if (rl) return rl;
        return requestOTP(request, env);
      }
      if (method === "POST" && path === "/api/auth/otp/verify") {
        const rl = await checkRateLimit(request, env, "otp-verify", 10, 60);
        if (rl) return rl;
        return verifyOTP(request, env);
      }
      if (method === "GET" && path.startsWith("/api/auth/oauth/")) {
        const parts = path.split("/").filter(Boolean); // ["api","auth","oauth","google"]
        const provider = parts[3];
        if (parts[4] === "callback") return oauthCallback(request, env, provider);
        return oauthRedirect(request, env, provider);
      }
      if (method === "POST" && path === "/api/auth/desktop/magic") {
        const rl = await checkRateLimit(request, env, "desktop-magic", 5, 60);
        if (rl) return rl;
        return requestDesktopMagic(request, env);
      }
      if (path === "/api/auth/desktop/magic/confirm") {
        if (method === "GET") return confirmDesktopMagicPage(request);
        if (method === "POST") return confirmDesktopMagic(request, env);
      }
      if (method === "POST" && path === "/api/auth/desktop/exchange") {
        const rl = await checkRateLimit(request, env, "desktop-exchange", 20, 60);
        if (rl) return rl;
        return exchangeDesktopCode(request, env);
      }
      if (method === "GET" && path.startsWith("/api/auth/desktop/oauth/")) {
        const provider = path.split("/").filter(Boolean)[4];
        return oauthRedirect(request, env, provider);
      }

      // ── User profile ──────────────────────────────────────────────────────
      if (path === "/api/me" && method === "GET") return getMe(request, env);
      if (path === "/api/me" && method === "PATCH") return updateMe(request, env);
      if (path === "/api/profiles/lookup" && method === "POST") return lookupProfiles(request, env);
      // Device-credential exchange is unauthenticated (it IS the auth step) —
      // rate-limit tighter than peer traffic to blunt brute force on top of
      // the 256-bit secret space.
      if (method === "POST" && path === "/api/auth/device") {
        const rl = await checkRateLimit(request, env, "auth-device", 20, 60);
        if (rl) return rl;
        return exchangeDeviceToken(request, env, ctx);
      }

      // ── Devices ────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/devices/enroll") {
        const rl = await checkRateLimit(request, env, "devices-enroll", 10, 60);
        if (rl) return rl;
        return enrollDevice(request, env);
      }
      if (method === "GET" && path === "/api/devices") return listDevices(request, env);
      if (method === "DELETE" && path.startsWith("/api/devices/")) {
        const deviceId = path.slice("/api/devices/".length);
        if (deviceId && !deviceId.includes("/")) return revokeDevice(request, env, deviceId);
      }

      // ── Peers ──────────────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/peers/register") {
        const rl = await checkRateLimit(request, env, "peers-reg", 10, 60);
        if (rl) return rl;
        return registerPeer(request, env);
      }
      if (method === "POST" && path === "/api/peers/lookup") {
        const rl = await checkRateLimit(request, env, "peers-lookup", 60, 60);
        if (rl) return rl;
        return lookupPeers(request, env);
      }
      if (method === "POST" && path === "/api/peers/connectivity") {
        const rl = await checkRateLimit(request, env, "peers-connectivity", 120, 60);
        if (rl) return rl;
        return reportPeerConnectivity(request, env);
      }
      if (method === "GET" && path === "/api/peers/config") return getPeerConfig(request, env);

      // ── Hole-punching signal (WebSocket via Durable Object) ─────────────────
      if (path.startsWith("/api/signal/")) {
        const rl = await checkRateLimit(request, env, "signal", 60, 60);
        if (rl) return rl;
        const rawRoomId = path.split("/")[3];
        if (!rawRoomId) return json({ error: "room_id required" }, 400);
        const isPair = rawRoomId.startsWith("pair:");
        const roomId = rawRoomId;
        if (!isPair && !/^[A-Za-z0-9-]{1,128}$/.test(roomId)) {
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
          log({ event: "signal.token_verify_failed", level: "error", request_id: requestId, error: String(e) });
          return json({ error: "invalid token" }, 401);
        }
        if (!claims) return json({ error: "invalid token" }, 401);

        const owned = await env.DB
          .prepare("SELECT 1 FROM peers WHERE public_key = ? AND user_id = ?")
          .bind(pk, claims.sub)
          .first();
        if (!owned) return json({ error: "peer not owned by user" }, 403);

        // H1: gate the SignalDO on room membership. Two roomId conventions:
        //   1. "pair:<keyA>.<keyB>" (base64url/no-padding WG keys, sorted) — 1:1 hole-punch
        //      outside any lobby. Caller's pk must be one of the two halves.
        //   2. anything else — treated as a service-layer room id; we ask the
        //      service worker for the lobby member-ids and require the caller
        //      to be in that set.
        // Without one of these checks any authenticated user could connect to
        // an arbitrary roomId DO and snoop / inject ICE signaling.
        if (roomId.startsWith("pair:")) {
          const parsed = parsePairRoom(roomId);
          if (!parsed) return json({ error: "malformed pair roomId" }, 400);
          const [a, b] = parsed;
          if (pk !== a && pk !== b) return json({ error: "pk not part of this pair" }, 403);
        } else {
          if (!env.SERVICE_URL || !env.SERVICE_INTERNAL_TOKEN) {
            return json({ error: "service layer not configured; room signaling unavailable" }, 503);
          }
          let r: Response;
          try {
            // G6: signed short-lived headers instead of a static bearer token.
            const memberURL = `${env.SERVICE_URL}/api/internal/rooms/${encodeURIComponent(roomId)}/member-ids`;
            r = await fetch(memberURL, {
              headers: await signInternalHeaders(env.SERVICE_INTERNAL_TOKEN, "GET", memberURL),
              signal: AbortSignal.timeout(3000),
            });
          } catch (e) {
            log({ event: "signal.service_fetch_failed", level: "error", request_id: requestId, room_id: roomId, error: String(e) });
            return json({ error: "service unavailable" }, 502);
          }
          if (r.status === 404) return json({ error: "room not found" }, 404);
          if (!r.ok) return json({ error: `service returned ${r.status}` }, 502);
          try {
            const body = await r.json<{ user_ids: string[] }>();
            if (!body.user_ids?.includes(claims.sub)) {
              return json({ error: "not a member of this room" }, 403);
            }
          } catch (e) {
            log({ event: "signal.service_response_parse_failed", level: "error", request_id: requestId, room_id: roomId, error: String(e) });
            return json({ error: "service unavailable" }, 502);
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

      // Admin-gated operator fleet view (relay detail + backend health rollup).
      if (method === "GET" && path === "/api/control/fleet") return getFleetStatus(request, env);

      // ── Ban management ─────────────────────────────────────────────────────
      if (method === "POST" && path === "/api/ban") return createBan(request, env);
      if (method === "GET" && path === "/api/ban") return checkBan(request, env);
      if (method === "DELETE" && path.startsWith("/api/ban/")) {
        const banId = path.split("/")[3];
        return removeBan(request, env, banId);
      }

      // ── Admin: init DB schema ──────────────────────────────────────────────
      // Schema itself is managed via `wrangler d1 migrations apply DB`
      // (see control/migrations/). This route is kept as a no-op hook for
      // future seed data (admin user, default lobby, etc.).
      if (method === "POST" && path === "/api/admin/init-db") {
        if (env.ENVIRONMENT !== "development") {
          return json({ error: "Only available in development" }, 403);
        }
        const adminToken = (env as Env & { ADMIN_TOKEN?: string }).ADMIN_TOKEN;
        if (!adminToken) {
          log({
            event: "admin.init_db.misconfigured",
            level: "error",
            request_id: requestId,
          });
          return json({ error: "ADMIN_TOKEN not configured" }, 503);
        }
        const authHeader = request.headers.get("Authorization") ?? "";
        const presented = authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : "";
        if (!presented || presented !== adminToken) {
          log({
            event: "admin.init_db.unauthorized",
            level: "warn",
            request_id: requestId,
            has_header: authHeader.length > 0,
          });
          return json({ error: "unauthorized" }, 401);
        }
        return json({
          ok: true,
          msg: "schema is managed via 'wrangler d1 migrations apply'",
        });
      }

      // ── Health check ───────────────────────────────────────────────────────
      if (path === "/health" || path === "/") {
        return json({ status: "ok", service: "ourcord-control", ts: Date.now() });
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      log({ event: "request.error", level: "error", request_id: requestId, method, path, error: String(e) });
      // I7: only leak stack/message in development; production keeps the
      // generic 500 to avoid information disclosure.
      const detail = (env.ENVIRONMENT ?? "production") === "development"
        ? { error: "Internal server error", detail: (e as Error).message }
        : { error: "Internal server error" };
      return json(detail, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// Wraps auth.ts's json() to add the CORS header required by browser clients
// hitting the control plane directly. Behavior otherwise identical.
function json(data: unknown, status = 200): Response {
  const res = jsonBase(data, status);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
}

function parsePairRoom(roomId: string): [string, string] | null {
  const body = roomId.slice("pair:".length);
  const parts = body.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (parts[0] > parts[1]) return null;
  const a = decodeBase64URLKey(parts[0]);
  const b = decodeBase64URLKey(parts[1]);
  if (!a || !b) return null;
  return [a, b];
}

function decodeBase64URLKey(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  try {
    const bin = atob(padded);
    if (bin.length !== 32) return null;
    return btoa(bin);
  } catch {
    return null;
  }
}
