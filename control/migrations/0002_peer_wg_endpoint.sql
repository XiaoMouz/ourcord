-- Store the last daemon-reported WireGuard UDP endpoint hint.
-- This is used only as a manual/smoke fallback until automatic ICE endpoint
-- discovery is wired into the daemon.

ALTER TABLE peers ADD COLUMN wg_endpoint TEXT NOT NULL DEFAULT '';
