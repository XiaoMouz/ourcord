-- One-time PKCE-bound authorization codes returned to the desktop app after
-- browser OAuth or magic-link confirmation. D1 is authoritative so the
-- DELETE-before-issue exchange is global across Worker isolates.
CREATE TABLE IF NOT EXISTS desktop_auth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_desktop_auth_codes_expiry
  ON desktop_auth_codes(expires_at);
