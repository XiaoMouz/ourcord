-- Device-level credentials (Phase 2). A device enrolls once with a fresh user
-- JWT and receives a long-lived random secret; only its SHA-256 lands in D1.
-- The daemon later exchanges that secret for short-lived user JWTs, so a
-- device can run unattended without a human re-login every hour, and a single
-- device can be revoked without rotating the whole account.

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- WireGuard public key this credential is bound to (one live credential per
  -- device key; re-enrolling rotates it).
  public_key TEXT NOT NULL,
  -- SHA-256 hex of the secret. The plaintext is returned exactly once at
  -- enroll time and never stored.
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_pubkey ON device_tokens(public_key);
