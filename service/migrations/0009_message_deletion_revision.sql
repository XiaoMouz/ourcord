-- Let polling clients invalidate cached history without re-reading every page.
ALTER TABLE rooms ADD COLUMN message_deletion_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER IF NOT EXISTS messages_deletion_revision AFTER DELETE ON messages
BEGIN
  UPDATE rooms SET message_deletion_revision = message_deletion_revision + 1
    WHERE id = OLD.room_id;
END;
