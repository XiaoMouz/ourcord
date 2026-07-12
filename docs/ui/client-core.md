# Client core / UI separation

Goal: the client **core** (all logic to drive a running `ourcordd`) is decoupled
from the **interaction layer** (CLI, TUI, native GUIs), so adding a TUI or a
per-platform GUI never means maintaining a second copy of the daemon-control
logic. The core lives in `daemon/pkg/client`; each UI is a thin presenter over
it.

## Design

```
             ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
             │ ourcord-cli │   │ ourcord-tui │   │  GUI (…)    │  ← presenters
             └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
                    └─────────────────┼─────────────────┘
                            daemon/pkg/client (typed core)   ← no UI, no os.Exit
                                      │
                       daemon/pkg/ipc (JSON-over-unix-socket)
                                      │
                                  ourcordd
```

`daemon/pkg/client` returns typed values (`ipc.DaemonStatus`, `[]ipc.ConnectedPeer`)
and errors — never prints, never parses flags, never calls `os.Exit`. Daemon-side
rejections surface as `client.DaemonError`; transport failures as the underlying
error. The stable field contract is `proto/ourcord/v1/daemon.proto`.

## Findings — coupling audit (recorded)

| # | Issue | Severity | Status |
|---|---|---|---|
| C1 | `ourcord-cli/main.go` mixed arg-parsing, raw `ipc.Call`, response decoding, stdout/stderr, and `os.Exit` in one place — no reusable core. A TUI would have had to re-derive command names, params, and `Data interface{}` decoding. | High | **Fixed** — extracted `daemon/pkg/client`; `main.go` is now a thin presenter. |
| C2 | IPC responses are `IPCResponse{Data interface{}}`; every consumer had to re-marshal to get typed data. | Med | **Fixed** — `client` exposes typed `Status()`/`ListPeers()` etc. via a generic `decode`. |
| C3 | `diagnostics.go` dialed IPC directly with its own key-loading helper. | Med | **Fixed** — now uses `client.Dial`/`Status`/`ListPeers`. |
| C4 | Device + diagnostics **core** logic (`enrollDevice`, `listDevices`, `revokeDevice`, `collectDiagnostics`) was UI-free but lived in `package main` under `cmd/ourcord-cli`, so a TUI/GUI could not import it. | Med | **Fixed** — moved to `daemon/pkg/client` (`devices.go`, `diagnostics.go`) as exported `EnrollDevice`/`ListDevices`/`RevokeDevice`/`CollectDiagnostics`; the CLI keeps only the flag-parsing presenters. |
| C5a | No presenter-agnostic "view model" (a status/peers poller a UI can subscribe to). | — | **Fixed** — `client.Watch(ctx, socket, interval)` streams `Snapshot{Status, Peers, Err}`; dials lazily and re-dials on error so it survives a daemon restart. CLI `watch` renders it as a live read-only view (dependency-free). |
| C5b | No interactive TUI. | — | **Fixed** — `cmd/ourcord-tui` (Bubble Tea) renders `client.Watch` snapshots and drives connect/disconnect/enter-network/leave via the typed `client` ops. Model logic is unit-tested; it shares 100% of its daemon logic with the CLI. |

`daemon/pkg/client` is now the complete UI-agnostic surface: daemon IPC ops
(`client.go`), device/control-plane ops (`devices.go`), and diagnostics
collection (`diagnostics.go`). `cmd/ourcord-cli` contains only presenters and has
no core logic left.

## Status

CLI and TUI both work over one shared core (`daemon/pkg/client`): daemon IPC ops,
device/control-plane ops, diagnostics, and the `Watch` view-model. `ourcord-cli`
and `ourcord-tui` contain only presentation. A future GUI is a third presenter
over the same package.

The TUI has two screens over the same core: the live network view
(`client.Watch` + IPC ops) and a device-management screen (`[D]`) that reuses
`client.ListDevices` / `client.RevokeDevice` — proving the *control-plane* ops
are presenter-agnostic too, not just the daemon IPC ops.

The TUI now has three screens over the same core: live network (status + peer
table with `[jk]` selection), per-peer detail (`[enter]` — full transport/flap
fields, tracked live by public key), and device management (`[D]`).

The wire transport is now **gRPC** (proto/ourcord/v1) over the authenticated
unix socket; the JSON adapter is gone. The swap changed only `daemon/pkg/ipc` +
`daemon/pkg/client` internals — the CLI and TUI needed **zero changes**, which
is the separation working exactly as designed.

## Next steps

1. Richer TUI: scrollable peer list for large meshes; peer-detail actions.
2. Native GUIs (`ui/desktop`, `ui/mobile`) bind to the same core; non-Go stacks
   can implement the proto contract directly against the daemon's gRPC socket.

## Verification

- `(cd daemon && go build ./... && go vet ./... && go test ./...)`.
- `daemon/pkg/client` has a round-trip test against a real in-process IPC server
  (`client_test.go`) covering typed decode + daemon-rejection → error.
- CLI behavior is unchanged: `status`/`peers` still emit the same JSON; mutating
  commands report via exit code.
