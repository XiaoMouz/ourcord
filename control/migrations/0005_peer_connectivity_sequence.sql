-- Add sequence arbitration metadata for per-edge connectivity observations.
--
-- Existing rows remain valid legacy observations (empty epoch / seq=0) and are
-- gradually replaced by sequenced daemon reports.

ALTER TABLE peer_connectivity
  ADD COLUMN source TEXT NOT NULL DEFAULT '' CHECK(source IN ('','derp_baseline','ice','reachability'));

ALTER TABLE peer_connectivity
  ADD COLUMN quality INTEGER NOT NULL DEFAULT 0;

ALTER TABLE peer_connectivity
  ADD COLUMN reporter_public_key TEXT NOT NULL DEFAULT '';

ALTER TABLE peer_connectivity
  ADD COLUMN reporter_epoch TEXT NOT NULL DEFAULT '';

ALTER TABLE peer_connectivity
  ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

ALTER TABLE peer_connectivity
  ADD COLUMN observed_at INTEGER;
