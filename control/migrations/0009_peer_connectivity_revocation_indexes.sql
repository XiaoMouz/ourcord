-- Device revocation spans networks; the network-first primary key cannot
-- look up either endpoint alone without scanning the complete topology.
CREATE INDEX IF NOT EXISTS idx_peer_connectivity_src ON peer_connectivity(src_public_key);
CREATE INDEX IF NOT EXISTS idx_peer_connectivity_dst ON peer_connectivity(dst_public_key);
