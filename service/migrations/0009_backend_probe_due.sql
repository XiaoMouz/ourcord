CREATE INDEX IF NOT EXISTS idx_file_backends_probe_due
  ON file_backends(active, last_health_at, id) WHERE active = 1;
