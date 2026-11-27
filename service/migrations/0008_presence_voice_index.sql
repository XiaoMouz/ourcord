-- Bound room deletion's ON DELETE SET NULL lookup to the room's participants.
-- Idle presence does not need an index entry.
CREATE INDEX IF NOT EXISTS idx_lobby_presence_voice
  ON lobby_presence(voice_room_id) WHERE voice_room_id IS NOT NULL;
