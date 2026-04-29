// D1 schema initialization SQL for the control layer
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  banned_at INTEGER
);

CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'unknown',
  -- All timestamp columns in this schema are UNIX seconds (Math.floor(Date.now()/1000)).
  -- peers.last_seen historically used milliseconds; H7 unified everything to seconds.
  last_seen INTEGER NOT NULL DEFAULT 0,
  ip4 TEXT NOT NULL DEFAULT '' UNIQUE,
  ip6 TEXT NOT NULL DEFAULT '' UNIQUE,
  -- DERP node public key (Tailscale tailcfg.NodePublic.String() format,
  -- "nodekey:HEX..."). Reported by daemons that also speak DERP. Empty for
  -- legacy registrations. Used by relay /api/relay/banned-keys to translate
  -- WG-key bans into DERP-key admit denials so banned users can't fall back
  -- to plain DERP to keep talking. See G12 in audit notes.
  derp_node_key TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS relay_servers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region TEXT NOT NULL DEFAULT 'unknown',
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 443,
  mode TEXT NOT NULL DEFAULT 'personal' CHECK(mode IN ('personal','lobby','rental')),
  capacity_kbps INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  registered_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL DEFAULT 0,
  -- One relay per (owner, hostname, port). Without this, every restart of a
  -- relay that can't recover its persisted relay-id would leak a duplicate
  -- relay_servers row, eventually flooding /api/relay/map ranking with
  -- inactive ghosts. Combined with state.SaveRelayID on the relay side this
  -- guarantees idempotent registration. See G7/G8 in audit notes.
  UNIQUE(owner_id, hostname, port)
);

CREATE TABLE IF NOT EXISTS relay_lobby_bindings (
  relay_id TEXT NOT NULL REFERENCES relay_servers(id) ON DELETE CASCADE,
  lobby_id TEXT NOT NULL,
  PRIMARY KEY (relay_id, lobby_id)
);

CREATE TABLE IF NOT EXISTS bans (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('user','peer','relay')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS stun_servers (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 3478,
  region TEXT NOT NULL DEFAULT 'global',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_peers_user_id ON peers(user_id);
CREATE INDEX IF NOT EXISTS idx_peers_public_key ON peers(public_key);
CREATE INDEX IF NOT EXISTS idx_bans_target ON bans(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_relay_servers_owner ON relay_servers(owner_id);

-- Per-relay peer denylist. Lobby owners (or relay owners directly) can refuse
-- specific peers without making them globally banned. Used by relay servers
-- to filter incoming connections (see /api/relay/banned-keys?relay_id=...).
CREATE TABLE IF NOT EXISTS relay_denied_peers (
  relay_id TEXT NOT NULL REFERENCES relay_servers(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (relay_id, public_key)
);

-- Coarse per-relay load report so control can rank in /api/relay/map.
-- Updated by relay heartbeat alongside last_heartbeat.
CREATE TABLE IF NOT EXISTS relay_load (
  relay_id TEXT PRIMARY KEY REFERENCES relay_servers(id) ON DELETE CASCADE,
  active_conns INTEGER NOT NULL DEFAULT 0,
  bytes_per_sec INTEGER NOT NULL DEFAULT 0,
  reported_at INTEGER NOT NULL DEFAULT 0
);
`;
