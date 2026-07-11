# OurCord Protobuf Definitions

`ourcord/v1/daemon.proto` is the source of truth for the stable UI ↔ daemon
IPC API. It freezes the RPC names, message fields, field numbers, and network
path enum before desktop or mobile clients are introduced.

## Scope

This first contract deliberately covers the daemon boundary only:

- daemon status and transport diagnostics;
- peer-list state;
- connect/disconnect and enter/leave-network operations.

It does **not** convert the browser-facing control/service REST APIs to
protobuf. Lobby, message, and file APIs remain JSON HTTP APIs. Media controls
will be added in a later `ourcord.v1` file after their session model is
designed.

## Current wire compatibility

The running daemon currently uses authenticated NDJSON over a Unix socket, not
gRPC. Its JSON names map to this contract as follows:

| Legacy JSON | Stable proto field / RPC |
| --- | --- |
| `status` | `DaemonService.GetStatus` / `GetStatusResponse.status` |
| `list_peers` | `DaemonService.ListPeers` / `ListPeersResponse` |
| `connect`, `disconnect` | corresponding `*Response.result` operation result |
| `enter_network` | `EnterNetworkRequest.network_id` |
| `leave_network` | `LeaveNetwork` |
| string paths (`direct`, `derp`, `next-hop`, …) | `Path` enum |
| `ip4`, `ip6` | `ipv4`, `ipv6` |
| `next_hop` | `next_hop_public_key` |
| `last_seen_secs` | `last_seen_seconds` |
| `path_transitions`, `path_dwell_secs`, `flapping` | `ConnectedPeer.path_transitions` / `path_dwell_seconds` / `flapping` |
| `path_flaps_total` | `DaemonStatus.path_flaps_total` |
| `room_id` | *(none — intentionally omitted)* |

The JSON `DaemonStatus.room_id` is a legacy field kept only for older callers
and is deliberately **not** represented in the proto: the stable identifier is
`network_id` (`DaemonStatus.network_id`), which carries the room's
`vpn_namespace` or a `pair:` id. New clients must read `network_id`; `room_id`
will be dropped from the JSON adapter once no caller depends on it. The adapter
being a superset of the frozen schema here is expected, not schema drift.

`enter_room`, `leave_room`, `force_derp`, and `ping` are legacy CLI or
diagnostic commands. They are intentionally absent from the stable UI API.
`enter_room` remains a compatibility alias in the daemon until callers have
migrated to the room's `vpn_namespace` and `EnterNetwork`.

## Compatibility rules

1. Never reuse a field number or enum number. Removed fields are reserved.
2. Additive fields must be optional from an older client's perspective; clients
   must ignore fields and enum values they do not recognise.
3. A semantic change to an existing field requires a new field or `v2`; do not
   silently reinterpret it.
4. Generated Go/TypeScript bindings must replace the handwritten daemon IPC
   types in the same change that switches the wire transport. Until then,
   `daemon/pkg/ipc/types.go` is the compatibility adapter and must remain
   field-equivalent to this schema.

## Generation

The directory is a Buf module (`buf.yaml`); `buf.gen.yaml` defines Go and
TypeScript generation. Once `buf` is available in the build image, run:

```bash
cd proto
buf lint
buf generate
# Enable after this initial schema has landed on main:
buf breaking --against '../.git#branch=main'
```

Bindings are written to the ignored `proto/gen/` build directory. We do not
commit hand-written `.pb.go` files: generated bindings must come from the
checked-in schema. CI should generate them and verify schema compatibility
before the JSON compatibility adapter is replaced. The first introduction of a
schema cannot run `buf breaking` against an empty `main`; enable that check on
the next schema-changing pull request.
