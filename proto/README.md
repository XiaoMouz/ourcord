# OurCord Protobuf Definitions (future source of truth)

The current implementation uses ad-hoc JSON over HTTP for control, service, daemon, and signaling flows. Proto is still empty and should become the versioned source of truth for daemon ↔ UI IPC and any shared control/service wire shapes once those contracts are frozen. Existing inline shapes should be marked `TODO(proto)` when they are expected to move here.
