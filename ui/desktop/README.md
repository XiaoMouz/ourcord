# OurCord Desktop

Windows-first Tauri 2 + React presenter for the existing daemon client core.
The WebView talks only to an allowlisted Rust command; the Go bridge owns local
gRPC, account tokens, service REST calls and OS credential storage.

The Rust shell keeps one long-lived `ourcord-desktop-bridge` sidecar and
multiplexes `bridge_call` requests over line-delimited JSON (correlated by id,
respawned on death). Do not revert to `--once` per-call spawning: the UI polls
`daemon.snapshot` at 1 Hz, and per-call spawning also leaks request payloads
(auth codes) into the process command line.

The Apple Silicon bundle also carries `ourcordd` as a managed sidecar. Tauri
starts it with the app, retries after an unavailable snapshot, and stops the
owned process when the window exits. It is user-mode only: full utun and route
setup still requires the separately installed launchd/root helper described in
`docs/PLATFORMS.md`.

Frontend layout: `src/App.tsx` orchestrates state; `src/components/*` are pure
presenters; `src/{bridge,prefs,messages,names,quality,format,menu}.ts` hold the
typed bridge surface and testable logic (voice-pref persistence, message
merging, display-name cache, connection-quality grading, formatting, menu
clamping). `src/dialog.tsx` provides promise-based in-app `confirm`/`prompt`
(the app never uses browser dialogs). Daemon/service knowledge belongs in the
Go bridge or `daemon/pkg/client`, never in components.

File transfers (`files.upload`/`files.download`) run through the Go bridge on a
separate context-bounded HTTP client (not the 15s API client) so large files
are not truncated. Upload follows the service's tiered flow
(initiate → PUT to the R2 proxy or a presigned backend → complete); the WebView
only passes an OS file-picker path (`tauri-plugin-dialog`), never bytes.

```bash
# frontend
pnpm install
pnpm typecheck
pnpm test

# bridge (from repository root)
(cd daemon && go build -o ../ui/desktop/src-tauri/binaries/ourcord-desktop-bridge ./cmd/ourcord-desktop-bridge)
(cd daemon && go build -o ../ui/desktop/src-tauri/binaries/ourcordd ./cmd/ourcordd)

# native app (requires Rust and the Tauri Windows prerequisites)
pnpm tauri dev
```

For a Windows bundle the bridge binary must use Tauri's target-triple suffix,
for example `ourcord-desktop-bridge-x86_64-pc-windows-msvc.exe`.
