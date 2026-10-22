import type { Env } from "./types";
import { json } from "./auth";
import { log } from "./log";

// This endpoint exposes only public aggregate data. Keep a short snapshot at
// each edge location without adding index writes to every device heartbeat.
export async function getPublicStatus(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  // Query strings and caller headers cannot create extra cache variants.
  const key = new Request(new URL("/api/control/status", request.url));
  if (cache) {
    try {
      const cached = await cache.match(key);
      if (cached) return cached;
    } catch {
      log({ event: "control_status.cache_read_failed", level: "warn" });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const [users, peers, relays, bans] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM peers WHERE last_seen > ?").bind(now - 300).first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM relay_servers WHERE active = 1 AND last_heartbeat > ?").bind(now - 120).first<{ c: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM bans WHERE expires_at IS NULL OR expires_at > ?").bind(now).first<{ c: number }>(),
  ]);
  const response = json({
    status: "ok", environment: env.ENVIRONMENT ?? "unknown",
    counts: {
      users: users?.c ?? 0, active_peers_5m: peers?.c ?? 0,
      active_relays: relays?.c ?? 0, active_bans: bans?.c ?? 0,
    },
    ts: Date.now(),
  });
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Cache-Control", "public, max-age=15");
  if (cache) {
    ctx.waitUntil(cache.put(key, response.clone()).catch(() => {
      log({ event: "control_status.cache_write_failed", level: "warn" });
    }));
  }
  return response;
}
