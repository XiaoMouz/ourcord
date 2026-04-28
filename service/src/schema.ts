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
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

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
CREATE INDEX IF NOT EXISTS idx_lobby_members_user ON lobby_members(user_id);
`;
