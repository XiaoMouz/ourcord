-- Global replay guard for control→service internal calls (G6). A random 128-bit
-- nonce is single-use within the signature freshness window; recording it in D1
-- (strongly consistent) closes the cross-isolate replay gap that the per-isolate
-- memory cache left open. expires_at drives opportunistic cleanup.
CREATE TABLE IF NOT EXISTS internal_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_internal_nonces_expires ON internal_nonces(expires_at);
