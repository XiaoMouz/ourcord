-- Ephemeral desktop presence for lobby member lists and voice-room rosters.
-- Rows are bounded by lobby membership and expire logically after 90 seconds;
-- retaining expired rows avoids a cleanup cron on this small-group dataset.
CREATE TABLE IF NOT EXISTS lobby_presence (
  lobby_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  voice_room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  PRIMARY KEY (lobby_id, user_id),
  FOREIGN KEY (lobby_id, user_id)
    REFERENCES lobby_members(lobby_id, user_id) ON DELETE CASCADE
);

