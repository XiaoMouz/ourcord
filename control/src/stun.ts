import { Env, StunServer } from "./types";
import { requireAuth, generateId, isUserBanned } from "./auth";

// GET /api/stun/servers — return STUN server list, optionally filtered by region
export async function getStunServers(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;

  const url = new URL(request.url);
  const region = url.searchParams.get("region");

  let stmt = region
    ? env.DB.prepare("SELECT * FROM stun_servers WHERE active = 1 AND region = ? ORDER BY id").bind(region)
    : env.DB.prepare("SELECT * FROM stun_servers WHERE active = 1 ORDER BY region, id");

  const servers = await stmt.all<StunServer>();
  return json({ servers: servers.results });
}

// POST /api/stun/servers — admin: add a STUN server
export async function addStunServer(request: Request, env: Env): Promise<Response> {
  // TODO: add admin role check
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
