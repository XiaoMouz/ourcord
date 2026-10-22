-- Reservations include pending uploads and objects awaiting physical deletion.
ALTER TABLE files ADD COLUMN upload_started_at INTEGER;
UPDATE files SET upload_expires_at = created_at + 1800
  WHERE upload_status = 'pending' AND upload_expires_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_pending_expiry
  ON files(upload_expires_at) WHERE upload_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_files_failed
  ON files(upload_status) WHERE upload_status = 'failed';

CREATE TABLE IF NOT EXISTS r2_usage (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
  reserved_files INTEGER NOT NULL DEFAULT 0 CHECK(reserved_files >= 0)
);
INSERT OR IGNORE INTO r2_usage (id, reserved_bytes, reserved_files)
  SELECT 1, COALESCE(SUM(size_bytes), 0), COUNT(*) FROM files WHERE storage_location = 'r2';

-- No FK: this must survive deletion of the file, room, and lobby.
CREATE TABLE IF NOT EXISTS r2_deletion_queue (
  storage_key TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  not_before INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_r2_deletion_due ON r2_deletion_queue(not_before);

CREATE TRIGGER IF NOT EXISTS files_r2_queue_reserve AFTER INSERT ON r2_deletion_queue
BEGIN
  UPDATE r2_usage SET reserved_bytes = reserved_bytes + NEW.size_bytes,
                      reserved_files = reserved_files + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS files_r2_reserve AFTER INSERT ON files
WHEN NEW.storage_location = 'r2'
BEGIN
  UPDATE r2_usage SET reserved_bytes = reserved_bytes + NEW.size_bytes,
                      reserved_files = reserved_files + 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS files_r2_enqueue AFTER DELETE ON files
WHEN OLD.storage_location = 'r2'
BEGIN
  INSERT OR IGNORE INTO r2_deletion_queue (storage_key, size_bytes, not_before)
  VALUES (OLD.storage_key, OLD.size_bytes,
    MAX(unixepoch(), COALESCE(OLD.upload_started_at, 0) + 660));
  UPDATE r2_usage SET reserved_bytes = reserved_bytes - OLD.size_bytes,
                      reserved_files = reserved_files - 1 WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS files_r2_release AFTER DELETE ON r2_deletion_queue
BEGIN
  UPDATE r2_usage SET reserved_bytes = reserved_bytes - OLD.size_bytes,
                      reserved_files = reserved_files - 1 WHERE id = 1;
END;
