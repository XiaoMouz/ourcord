-- Path-flap telemetry per directed edge (from the daemon's per-peer path
-- observer). flap_count is the source's cumulative path-label transition count;
-- flapping marks an edge currently churning. Control records these for
-- observability and biases next-hop selection away from a flapping edge.
ALTER TABLE peer_connectivity
  ADD COLUMN flap_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE peer_connectivity
  ADD COLUMN flapping INTEGER NOT NULL DEFAULT 0 CHECK(flapping IN (0,1));
