# OurCord Desktop

Windows-first Tauri 2 + React presenter for the existing daemon client core.
The WebView talks only to an allowlisted Rust command; the Go bridge owns local
gRPC, account tokens, service REST calls and OS credential storage.

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
