-- Match the complete pagination order, including messages in the same second.
CREATE INDEX IF NOT EXISTS idx_messages_room_cursor ON messages(room_id, created_at, id);
DROP INDEX IF EXISTS idx_messages_room;
