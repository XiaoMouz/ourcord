# OurCord Desktop

Windows-first Tauri 2 + React presenter for the existing daemon client core.
The WebView talks only to an allowlisted Rust command; the Go bridge owns local
gRPC, account tokens, service REST calls and OS credential storage.

The Rust shell keeps one long-lived `ourcord-desktop-bridge` sidecar and
multiplexes `bridge_call` requests over line-delimited JSON (correlated by id,
respawned on death). Do not revert to `--once` per-call spawning: the UI polls
`daemon.snapshot` at 1 Hz, and per-call spawning also leaks request payloads
(auth codes) into the process command line.

Frontend layout: `src/App.tsx` orchestrates state; `src/components/*` are pure
presenters; `src/{bridge,prefs,messages,names}.ts` hold the typed bridge
surface and testable logic (voice-pref persistence, message merging,
display-name cache). Daemon/service knowledge belongs in the Go bridge or
`daemon/pkg/client`, never in components.

```bash
# frontend
pnpm install
pnpm typecheck
pnpm test

# bridge (from repository root)
(cd daemon && go build -o ../ui/desktop/src-tauri/binaries/ourcord-desktop-bridge ./cmd/ourcord-desktop-bridge)

# native app (requires Rust and the Tauri Windows prerequisites)
pnpm tauri dev
```

For a Windows bundle the bridge binary must use Tauri's target-triple suffix,
for example `ourcord-desktop-bridge-x86_64-pc-windows-msvc.exe`.
