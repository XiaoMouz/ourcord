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
| C4 | Device + diagnostics **core** logic (`enrollDevice`, `listDevices`, `revokeDevice`, `collectDiagnostics`) is UI-free but lives in `package main` under `cmd/ourcord-cli`, so a TUI/GUI cannot import it. | Med | **Open** — relocate device/control-plane ops into `daemon/pkg/client` (or a sibling `pkg/clientcore`) so all presenters share them. |
| C5 | No TUI yet; no presenter-agnostic "view model" (e.g. a periodic status/peers poller a TUI can subscribe to). | — | **Open** — build `cmd/ourcord-tui` (bubbletea) once C4 lands. |

## Next steps

1. **C4** — move `enroll/devices/revoke-device` and diagnostics collection into
   the client-core package as typed methods (they already return `(T, error)`;
   just change their home and drop the `run*` presenter wrappers into the CLI).
2. **C5** — add `cmd/ourcord-tui` (Bubble Tea) that renders status/peers and
   drives connect/enter-network through `daemon/pkg/client`, proving the core is
   presenter-agnostic. Add a core `Watch`/poll helper both CLI (`--watch`) and TUI
   can reuse.
3. Keep the proto contract (`proto/ourcord/v1/daemon.proto`) as the single field
   source; when the gRPC transport replaces the JSON IPC adapter, only
   `daemon/pkg/ipc` + `daemon/pkg/client` internals change, not the presenters.

## Verification

- `(cd daemon && go build ./... && go vet ./... && go test ./...)`.
- `daemon/pkg/client` has a round-trip test against a real in-process IPC server
  (`client_test.go`) covering typed decode + daemon-rejection → error.
- CLI behavior is unchanged: `status`/`peers` still emit the same JSON; mutating
  commands report via exit code.
