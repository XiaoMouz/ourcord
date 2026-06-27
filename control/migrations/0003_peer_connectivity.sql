-- Per-network peer connectivity observations reported by daemons.
-- Control uses this directed graph to compute one-hop A-B-C next-hop routes.

CREATE TABLE IF NOT EXISTS peer_connectivity (
  network_id TEXT NOT NULL,
  src_public_key TEXT NOT NULL,
  dst_public_key TEXT NOT NULL,
  -- Legacy alias for "ICE direct"; kept for older diagnostics.
  direct INTEGER NOT NULL DEFAULT 0 CHECK(direct IN (0,1)),
  ice_direct INTEGER NOT NULL DEFAULT 0 CHECK(ice_direct IN (0,1)),
  wg_reachable INTEGER NOT NULL DEFAULT 0 CHECK(wg_reachable IN (0,1)),
  -- ice | derp | wg_relay | '' for legacy callers.
  transport TEXT NOT NULL DEFAULT '' CHECK(transport IN ('','ice','derp','wg_relay')),
  rtt_ms INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (network_id, src_public_key, dst_public_key)
);

CREATE INDEX IF NOT EXISTS idx_peer_connectivity_network
  ON peer_connectivity(network_id, src_public_key, dst_public_key);
