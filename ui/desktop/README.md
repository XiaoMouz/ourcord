# OurCord Desktop

Windows-first Tauri 2 + React presenter for the existing daemon client core.
The WebView talks only to an allowlisted Rust command; the Go bridge owns local
gRPC, account tokens, service REST calls and OS credential storage.

The Rust shell keeps one long-lived `ourcord-desktop-bridge` sidecar and
multiplexes `bridge_call` requests over line-delimited JSON (correlated by id,
respawned on death). Do not revert to `--once` per-call spawning: the UI polls
`daemon.snapshot` at 1 Hz, and per-call spawning also leaks request payloads
(auth codes) into the process command line.

Desktop login keeps one pending PKCE attempt in the credential store, scoped to
the configured control URL. `auth.begin` resumes that attempt across restarts
instead of replacing its verifier. `restart: true` explicitly starts a fresh
attempt; successful exchange and logout clear it. The local attempt expires
after 12 minutes of inactivity (the server's 10-minute email/OAuth flow plus
60-second desktop code and one minute for delivery), without extending any
server-issued token lifetime.
Sending an email or clicking OAuth activates the attempt for that full window;
OAuth URLs are refreshed on click rather than reusing an idle login page's URL.
The single-instance desktop's bridge serializes begin, send and exchange to
avoid verifier replacement during in-flight authentication. This is not a
cross-process credential lock. Legacy raw verifiers migrate on first access,
including a cold-start exchange before the login screen initializes.

The Apple Silicon bundle carries `ourcordd` and installs it as the root
`app.ourcord.daemon` LaunchDaemon after one macOS administrator prompt. The
daemon owns utun/routes; the desktop bridge remains unprivileged and reaches it
through a per-user mode-0600 socket guarded by both peer UID and the existing
HMAC handshake. Updated app bundles replace the helper on the next launch.

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
