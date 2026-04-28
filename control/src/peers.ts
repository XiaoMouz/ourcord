import { Env, Peer } from "./types";
import { requireAuth, generateId } from "./auth";
import { allocateVPNIP } from "./ipam";

// POST /api/peers/register — register a new device/peer
// Body: { public_key: string, name: string, platform: string }
export async function registerPeer(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  const body = await request.json<{ public_key: string; name: string; platform: string }>();
  if (!body.public_key || !body.platform) {
    return json({ error: "public_key and platform required" }, 400);
  }

  // Check for existing peer with same public key
  const existing = await env.DB
    .prepare("SELECT id, user_id FROM peers WHERE public_key = ?")
    .bind(body.public_key)
    .first<{ id: string; user_id: string }>();

  if (existing) {
    if (existing.user_id !== userId) {
      return json({ error: "Public key already registered to another user" }, 409);
    }
    // Update last_seen and return existing
    await env.DB
      .prepare("UPDATE peers SET last_seen = ?, name = ?, platform = ? WHERE id = ?")
      .bind(Date.now(), body.name ?? "", body.platform, existing.id)
      .run();
    const peer = await env.DB
      .prepare("SELECT * FROM peers WHERE id = ?")
      .bind(existing.id)
      .first<Peer>();
    return json({ peer, config: buildWireGuardConfig(peer!) });
  }

  // Allocate VPN IPs
  const { ip4, ip6 } = await allocateVPNIP(env.KV, env.DB);

  const id = generateId();
  const now = Date.now();
  await env.DB
    .prepare(
      "INSERT INTO peers (id, user_id, public_key, name, platform, last_seen, ip4, ip6) VALUES (?,?,?,?,?,?,?,?)"
    )
    .bind(id, userId, body.public_key, body.name ?? "", body.platform, now, ip4, ip6)
    .run();

  const peer = await env.DB
    .prepare("SELECT * FROM peers WHERE id = ?")
    .bind(id)
    .first<Peer>();

  return json({ peer, config: buildWireGuardConfig(peer!) }, 201);
}

// GET /api/peers/config — get full peer list for building WireGuard config
export async function getPeerConfig(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuth(request, env);
  if (authResult instanceof Response) return authResult;
  const { sub: userId } = authResult;

  // Update last_seen for the requesting peer (identified by public key header)
  const pubKey = request.headers.get("X-Peer-Public-Key");
  if (pubKey) {
    await env.DB
      .prepare("UPDATE peers SET last_seen = ? WHERE user_id = ? AND public_key = ?")
      .bind(Date.now(), userId, pubKey)
      .run();
  }

  // Return all active peers for this user (for full mesh config)
  const peers = await env.DB
    .prepare("SELECT * FROM peers WHERE user_id = ? ORDER BY last_seen DESC")
    .bind(userId)
    .all<Peer>();

  // Get relay server list
  const relays = await env.KV.get("relay_map", "json") as RelayEntry[] | null;

  return json({ peers: peers.results, relays: relays ?? [] });
}

interface RelayEntry {
  hostname: string;
  port: number;
  region: string;
  ipv4?: string;
  ipv6?: string;
}

function buildWireGuardConfig(peer: Peer): string {
  return [
    "[Interface]",
    `# PublicKey = ${peer.public_key}`,
    `Address = ${peer.ip4}/10, ${peer.ip6}/48`,
    "DNS = 100.100.100.100",
    "",
  ].join("\n");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
