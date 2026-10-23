-- The upload-status index serves chronological file listings. Replace the
-- redundant room/time index with a retention-class seek for upload quotas;
-- keep one index entry per file rather than adding another insert/delete cost.
CREATE INDEX IF NOT EXISTS idx_files_room_expiry ON files(room_id, expires_at);
DROP INDEX IF EXISTS idx_files_room;
