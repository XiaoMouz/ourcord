# OurCord Protobuf Definitions (Phase-2 placeholder)

Phase-1 uses ad-hoc JSON over HTTP for both control↔daemon and service↔daemon traffic, which is good enough to bootstrap auth, lobby and signaling flows. Phase-2 will define proto3 messages in this directory for ICE candidate exchange, DERP framing, and media negotiation, replacing the JSON shapes with versioned, codegen-friendly schemas. See plan.md `ph2-*` todos for scope and sequencing.
