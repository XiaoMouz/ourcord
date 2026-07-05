// Canonical schema versioning lives in ../migrations/ (wrangler d1 migrations
// apply). SCHEMA_SQL exists only for the dev /api/admin/init-db convenience
// and MUST equal the accumulated migrations — schema.test.ts enforces the
// statement-level equivalence, so a schema change means: add/extend a
// migration AND mirror it here.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lobbies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  icon TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text','voice','video','file')),
  position INTEGER NOT NULL DEFAULT 0,
  vpn_namespace TEXT
);

CREATE TABLE IF NOT EXISTS lobby_members (
  lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member','guest')),
  joined_at INTEGER NOT NULL,
  display_name TEXT,
  PRIMARY KEY (lobby_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachments TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  storage_location TEXT NOT NULL DEFAULT 'r2' CHECK(storage_location IN ('user_server','lobby_server','r2')),
  storage_key TEXT NOT NULL,
  -- Which registered file backend holds this file (NULL for R2). Kept even
  -- after the backend is deactivated, for auditability.
  backend_id TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
  ,
  upload_status TEXT NOT NULL DEFAULT 'uploaded' CHECK(upload_status IN ('pending','uploaded','failed')),
  upload_token_hash TEXT,
  upload_expires_at INTEGER,
  uploaded_at INTEGER,
  actual_size_bytes INTEGER,
  last_upload_error TEXT);

-- Autonomous file backends (Phase 2): user-run HTTP file servers forming the
-- storage priority chain 自建 → 分享 → 大厅 ahead of the R2 fallback.
-- lobby_id NULL = personal backend (自建, shareable); non-NULL = the lobby's
-- backend (大厅), usable by every lobby member.
CREATE TABLE IF NOT EXISTS file_backends (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lobby_id TEXT REFERENCES lobbies(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at INTEGER NOT NULL
  ,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown','healthy','unhealthy')),
  last_health_at INTEGER,
  last_health_error TEXT,
  upload_secret TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_file_backends_owner ON file_backends(owner_id);
CREATE INDEX IF NOT EXISTS idx_file_backends_lobby ON file_backends(lobby_id);

-- 分享: a personal backend granted to another user for their uploads.
CREATE TABLE IF NOT EXISTS file_backend_shares (
  backend_id TEXT NOT NULL REFERENCES file_backends(id) ON DELETE CASCADE,
  grantee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (backend_id, grantee_id)
);
CREATE INDEX IF NOT EXISTS idx_backend_shares_grantee ON file_backend_shares(grantee_id);

CREATE TABLE IF NOT EXISTS file_policies (
  lobby_id TEXT PRIMARY KEY REFERENCES lobbies(id) ON DELETE CASCADE,
  max_size_bytes INTEGER NOT NULL DEFAULT 104857600,  -- 100 MB default
  max_total_files INTEGER NOT NULL DEFAULT 0,         -- 0 = unlimited
  max_temp_files INTEGER NOT NULL DEFAULT 100,
  retain_days INTEGER NOT NULL DEFAULT 30,
  r2_enabled INTEGER NOT NULL DEFAULT 1,
  user_server_enabled INTEGER NOT NULL DEFAULT 1,
  lobby_server_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_rooms_lobby ON rooms(lobby_id);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_files_room ON files(room_id, created_at);
-- L4: runR2Cleanup scans WHERE storage_location='r2' AND expires_at <= ?
-- on a 5-minute cron. Without this partial index that is a full table scan
-- once the files table grows. The WHERE clause keeps the index small (only
-- rows that can ever expire) and matches the cleanup query exactly.
CREATE INDEX IF NOT EXISTS idx_files_expires
  ON files(storage_location, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_upload_status ON files(room_id, upload_status, created_at);
CREATE INDEX IF NOT EXISTS idx_file_backends_health ON file_backends(active, health_status, last_health_at);
CREATE INDEX IF NOT EXISTS idx_lobby_members_user ON lobby_members(user_id);

-- Invite codes for joining a lobby. Created by owner/admin; consumed (or
-- counted) by joinLobby. uses=0 + max_uses>0 means single/multi-use; max_uses=0
-- means unlimited until expires_at.
CREATE TABLE IF NOT EXISTS lobby_invites (
  code TEXT PRIMARY KEY,
  lobby_id TEXT NOT NULL REFERENCES lobbies(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invites_lobby ON lobby_invites(lobby_id);
`;
