# OurCord Protobuf Definitions (Phase-2 placeholder)

The current implementation uses ad-hoc JSON over HTTP for control, service, daemon, and signaling flows. Phase 2 will define proto3 messages in this directory for daemon ↔ UI IPC and any shared control/service wire shapes that need versioned, codegen-friendly schemas. See the top-level PRD for scope and sequencing.
