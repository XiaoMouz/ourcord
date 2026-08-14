-- Ephemeral network presence. A peer refreshes this lease while polling a
-- room-scoped config; switching networks overwrites the row, and an explicit
-- leave removes it. Abrupt disconnects are handled by the query-side TTL.

CREATE TABLE IF NOT EXISTS peer_presence (
  public_key TEXT PRIMARY KEY REFERENCES peers(public_key) ON DELETE CASCADE,
  network_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_peer_presence_network_seen
  ON peer_presence(network_id, last_seen);
