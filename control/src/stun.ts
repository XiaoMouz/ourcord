import { Env, StunServer } from "./types";
import { requireAuth, requireAdmin, generateId, checkBodySize } from "./auth";

// Public-STUN fallback. Used when the operator hasn't seeded stun_servers
// yet (fresh deploy, post-migration, dev sandbox). Without this the daemon's
// ICE gather would produce zero server-reflexive candidates and hole-punching
// would silently degrade to relay-only. Mirrors the well-known set used by
// Tailscale and most WebRTC SDKs; everything below is operated by Google /
// Cloudflare and exposes no PII.
const FALLBACK_STUN_SERVERS: StunServer[] = [
  { id: "fallback-google-1", host: "stun.l.google.com", port: 19302, region: "global", active: 1 },
  { id: "fallback-google-2", host: "stun1.l.google.com", port: 19302, region: "global", active: 1 },
  { id: "fallback-google-3", host: "stun2.l.google.com", port: 19302, region: "global", active: 1 },
  { id: "fallback-cloudflare", host: "stun.cloudflare.com", port: 3478, region: "global", active: 1 },
];

// GET /api/stun/servers — return STUN server list, optionally filtered by region.
// Returns the operator-seeded list from D1; if that list is empty the response
// falls back to a public set so daemons always have something to probe with.
// `source` indicates which path was taken — "db" or "fallback".
export async function getStunServers(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const region = url.searchParams.get("region");

  const stmt = region
    ? env.DB.prepare("SELECT * FROM stun_servers WHERE active = 1 AND region = ? ORDER BY id").bind(region)
    : env.DB.prepare("SELECT * FROM stun_servers WHERE active = 1 ORDER BY region, id");

  const servers = await stmt.all<StunServer>();
  if (servers.results.length === 0) {
    const filtered = region
      ? FALLBACK_STUN_SERVERS.filter((s) => s.region === region || s.region === "global")
      : FALLBACK_STUN_SERVERS;
    return json({ servers: filtered, source: "fallback" });
  }
  return json({ servers: servers.results, source: "db" });
}

// POST /api/stun/servers — admin: add a STUN server
export async function addStunServer(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 1024);
  if (tooBig) return tooBig;
  const auth = await requireAdmin(request, env);
  if (auth instanceof Response) return auth;
  const body = await request.json<{ host: string; port?: number; region?: string }>();
  if (!body.host) return json({ error: "host required" }, 400);

  const id = generateId();
  await env.DB
    .prepare("INSERT INTO stun_servers (id, host, port, region, active) VALUES (?,?,?,?,1)")
    .bind(id, body.host, body.port ?? 3478, body.region ?? "global")
    .run();

  return json({ id }, 201);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
