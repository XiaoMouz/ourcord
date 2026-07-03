-- Close the autonomous file-backend loop: upload state, completion token, and
-- backend health metadata.

ALTER TABLE files ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'uploaded'
  CHECK(upload_status IN ('pending','uploaded','failed'));
ALTER TABLE files ADD COLUMN upload_token_hash TEXT;
ALTER TABLE files ADD COLUMN upload_expires_at INTEGER;
ALTER TABLE files ADD COLUMN uploaded_at INTEGER;
ALTER TABLE files ADD COLUMN actual_size_bytes INTEGER;
ALTER TABLE files ADD COLUMN last_upload_error TEXT;

ALTER TABLE file_backends ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK(health_status IN ('unknown','healthy','unhealthy'));
ALTER TABLE file_backends ADD COLUMN last_health_at INTEGER;
ALTER TABLE file_backends ADD COLUMN last_health_error TEXT;

CREATE INDEX IF NOT EXISTS idx_files_upload_status ON files(room_id, upload_status, created_at);
CREATE INDEX IF NOT EXISTS idx_file_backends_health ON file_backends(active, health_status, last_health_at);
