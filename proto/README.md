# OurCord Protobuf Definitions

`ourcord/v1/daemon.proto` is the source of truth for the stable UI ↔ daemon
IPC API. It freezes the RPC names, message fields, field numbers, and network
path enum before desktop or mobile clients are introduced.

## Scope

This first contract deliberately covers the daemon boundary only:

- daemon status and transport diagnostics;
- peer-list state;
- connect/disconnect and enter/leave-network operations;
- Phase-3 voice control/status and audio device selection (`media.proto`).

It does **not** convert the browser-facing control/service REST APIs to
protobuf. Lobby, message, and file APIs remain JSON HTTP APIs. Voice controls
live in `ourcord/v1/media.proto`; video, screen-share, and remote-control
contracts have not been frozen yet.

## Current wire transport

The daemon serves this contract as **gRPC over an authenticated unix socket**:
`daemon/pkg/ipc` runs the SO_PEERCRED check and the W3 HMAC challenge-response
on the raw connection before HTTP/2 starts, then hands the conn to gRPC. The
JSON NDJSON transport has been removed; `daemon/pkg/client` is the only
supported way to drive the daemon and presenters (CLI/TUI/GUI) go through it.

Domain-type mapping (in `daemon/pkg/ipc/conv.go`, the single conversion point):

| Domain (`daemon/pkg/ipc`) | Proto |
| --- | --- |
| `DaemonStatus` / `ConnectedPeer` string paths | `Path` enum (unknown ⇒ `PATH_UNSPECIFIED` ⇒ `""`) |
| `IP4`, `IP6` | `ipv4`, `ipv6` |
| `NextHop` | `next_hop_public_key` |
| `LastSeenSecs` / `PathDwellSecs` | `last_seen_seconds` / `path_dwell_seconds` |
| `RoomID` | *(none — mirrors `network_id`; legacy field slated for removal)* |

`ping` and `force_derp` are diagnostic operations and live in
`ourcord/v1/diagnostics.proto` (`DaemonDiagnosticsService`), which is
**outside** the stable UI contract and may change freely. `enter_room` is a
client-side alias for `EnterNetwork` (the daemon resolves both identifiers
through the same path).

## Compatibility rules

1. Never reuse a field number or enum number. Removed fields are reserved.
2. Additive fields must be optional from an older client's perspective; clients
   must ignore fields and enum values they do not recognise.
3. A semantic change to an existing field requires a new field or `v2`; do not
   silently reinterpret it.
4. Generated bindings are the wire types. The domain structs in
   `daemon/pkg/ipc/types.go` are what the daemon core and presenters use;
   `daemon/pkg/ipc/conv.go` is the single mapping point between them and the
   generated types, and must stay complete when fields are added.

## Generation

The directory is a Buf module (`buf.yaml`); `buf.gen.yaml` defines Go and
TypeScript generation:

```bash
cd proto
buf lint
buf format --diff
buf generate
buf breaking --against '../.git#branch=main,subdir=proto'
```

**Go bindings are generated into the daemon module and committed**
(`daemon/pkg/pb/ourcordv1`): the daemon's gRPC services and `daemon/pkg/client`
import them, so they must exist at build time. Never edit them by hand — CI
regenerates and fails on any diff, so the committed bindings always match the
checked-in schema. TypeScript bindings remain build artifacts (gitignored
`gen/ts`) until a TS consumer exists. `buf breaking` ignores
`FILE_SAME_GO_PACKAGE` because the Go codegen location intentionally moved once
when the gRPC transport landed (see `buf.yaml`).
