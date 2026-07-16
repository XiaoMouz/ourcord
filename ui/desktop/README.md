# OurCord Desktop UI (Phase-4 placeholder)

There is no first-party desktop UI yet. `ourcord-cli` and `ourcord-tui` are the
supported presenters for current network and voice validation; both reuse
`daemon/pkg/client`. The planned desktop UI is Tauri + React and should consume
the daemon's authenticated local gRPC API (directly or through that shared
client core). Product GUI work belongs to Phase 4.
