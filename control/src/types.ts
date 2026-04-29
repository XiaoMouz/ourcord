// Cloudflare Workers environment bindings for the control layer
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SIGNAL: DurableObjectNamespace;
  ENVIRONMENT: string;
  JWT_SECRET?: string;
  OAUTH_GOOGLE_CLIENT_ID?: string;
  OAUTH_GOOGLE_CLIENT_SECRET?: string;
  OAUTH_GITHUB_CLIENT_ID?: string;
  OAUTH_GITHUB_CLIENT_SECRET?: string;
  EMAIL_API_KEY?: string; // for sending OTP emails
  // Comma-separated list of user ids treated as global admins. Used to gate
  // /api/ban and other operator-only endpoints. Empty / missing = nobody.
  ADMIN_USER_IDS?: string;
  // Base URL of the service layer worker (used for per-room peer scoping).
  // E.g. https://service.ourcord.example
  SERVICE_URL?: string;
  // Shared secret presented by control → service for member-list lookups.
  // Service treats requests with this header as trusted internal callers.
  SERVICE_INTERNAL_TOKEN?: string;
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
  banned_at: number | null;
}

export interface Peer {
  id: string;
  user_id: string;
  public_key: string; // WireGuard public key (base64)
  name: string;
  platform: "win" | "mac" | "linux" | "ios" | "android" | "web";
  last_seen: number;
  ip4: string; // assigned VPN IPv4 (e.g. 100.64.x.x)
  ip6: string; // assigned VPN IPv6
}

export interface RelayServer {
  id: string;
  owner_id: string;
  region: string;
  hostname: string;
  port: number;
  mode: "personal" | "lobby" | "rental";
  capacity_kbps: number;
  active: number;
  registered_at: number;
  last_heartbeat: number;
}

export interface Ban {
  id: string;
  target_type: "user" | "peer" | "relay";
  target_id: string;
  reason: string;
  created_at: number;
  expires_at: number | null;
}

export interface StunServer {
  id: string;
  host: string;
  port: number;
  region: string;
  active: number;
}
