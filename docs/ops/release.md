# Release / deploy runbook

Deploying the two Cloudflare Workers (`control`, `service`). The one rule that
must never be violated: **apply D1 migrations before deploying the code that
depends on the new schema**, and deploy **service before control** (control
makes signed internal calls into service).

Automation lives in `.github/workflows/deploy.yml` (manual `workflow_dispatch`);
the same steps can be run locally with the `pnpm` scripts below.

## One-time setup (per Cloudflare account)

1. Create resources and put their real IDs into `control/wrangler.toml` and
   `service/wrangler.toml` (they ship with `placeholder-replace-on-deploy`):
   ```bash
   npx wrangler d1 create ourcord-control      # → database_id
   npx wrangler d1 create ourcord-service      # → database_id
   npx wrangler kv namespace create KV         # control + service → id
   npx wrangler r2 bucket create ourcord-files # service FILES binding
   ```
   D1/KV IDs are not secret; commit the real values (or keep an untracked
   overlay). Set `[vars] ENVIRONMENT = "production"` for a prod deploy.
2. Provision Worker secrets once (never commit these):
   ```bash
   # control + service must share JWT_SECRET and SERVICE_INTERNAL_TOKEN.
   (cd control && npx wrangler secret put JWT_SECRET)
   (cd control && npx wrangler secret put SERVICE_INTERNAL_TOKEN)
   (cd control && npx wrangler secret put ADMIN_USER_IDS)
   (cd control && npx wrangler secret put EMAIL_API_KEY)   # OTP email sender
   (cd service && npx wrangler secret put JWT_SECRET)
   (cd service && npx wrangler secret put SERVICE_INTERNAL_TOKEN)
   ```
   `JWT_SECRET` is the shared control↔service HMAC (never call it
   `CONTROL_INTERNAL_SECRET`). `SERVICE_INTERNAL_TOKEN` gates the signed
   control→service internal calls.
3. In GitHub repo settings add secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. Use Cloudflare's **Edit Cloudflare Workers**
   token template, scoped only to the production account/zone. The Deploy
   workflow uses it for control/service; the Desktop public beta workflow uses
   it to publish the newly built installer and updater manifest to
   `ourcord.mou.best`.

## Deploy

The checked-in Worker configurations support Workers Free. Do not add
`limits.cpu_ms` on Free: the API rejects deployment with error 100328, even
though a local dry run succeeds. Free retains its platform CPU limit; request
rate limits and storage quotas are unchanged. Before intentionally switching
to Paid, configure a reviewed CPU cap in both Worker configurations, following
[the cost controls](cloudflare-cost-audit.md).

Preferred: run the **Deploy** workflow (`workflow_dispatch`) with target
`both` / `service` / `control`. It installs deps, then per worker runs
`pnpm run migrate` (D1 `--remote`) followed by `pnpm run deploy`.

Manual equivalent (service first):
```bash
(cd service && pnpm run migrate && pnpm run deploy)
(cd control && pnpm run migrate && pnpm run deploy)
```

## Desktop beta signing

The Windows SCM wrapper protects `%ProgramData%\OurCord` with an explicit,
inheritable DACL for SYSTEM, Administrators, and the wrapper's process user
before launching the daemon. Normal SCM launches run as SYSTEM. This replaces
inherited broad directory permissions and propagates to existing children with
inherited ACLs; Go's POSIX mode bits alone do not protect Windows state files.
Startup rejects a state directory that is a reparse point, a regular file, or
owned by an account other than the process user, SYSTEM, or Administrators.

The desktop beta workflow always signs Windows and macOS updater artifacts with
the Tauri updater key. Windows Authenticode signing is optional: leave the repository variable
`ENABLE_AZURE_SIGNING` unset (or set it to anything other than `true`) for an
unsigned beta installer. Windows SmartScreen will warn users because the
publisher is unverified, but the updater signature still protects downloaded
updates. Set the variable to `true` and provision the documented Azure secrets
and variables when a trusted publisher certificate is available.

The **Desktop public beta** workflow is also the single publication pipeline:

1. build the Windows x64 NSIS installer and Apple Silicon macOS DMG;
2. sign both Tauri updater payloads and merge their entries into `latest.json`;
3. update the private `desktop-beta` GitHub Release;
4. pass the exact installers to the website job as short-lived Actions
   artifacts;
5. publish them at stable `ourcord.mou.best/downloads/` URLs;
6. download both public installers again and require their SHA-256 values to
   match the platform builds before the workflow can turn green.

The same workflow builds an Apple Silicon DMG on `macos-15`, ad-hoc signs the
application bundle, and publishes both the DMG and the signed
`darwin-aarch64` updater archive. It is intentionally not Apple-notarized yet,
so Gatekeeper displays an unidentified-developer warning. The bundle installs
its `ourcordd` sidecar as a root LaunchDaemon after a native administrator
prompt; only the installing user's UID plus HMAC-authenticated IPC can control
it. A changed bundled daemon is upgraded on the first launch after an app
update.

Stable public artifacts are:

- `OurCord-Windows-x64-setup.exe`
- `OurCord-macOS-arm64.dmg`
- `OurCord-macOS-arm64.app.tar.gz` (updater payload)

The stable website filename intentionally does not contain the app version.
Versioned filenames remain in the GitHub Release, while the homepage and
Tauri updater always follow the latest successfully deployed beta.

`pnpm run migrate` applies any un-applied migrations in `migrations/`. Recent
schema changes that ship this way: service `0004_internal_nonces` (replay guard)
and control `0006_peer_connectivity_flap` (path-flap columns) — both must be
applied before their new code runs.

## Verify after deploy

- `curl https://<control>/` and `https://<service>/` return healthy.
- A successful Desktop public beta run shows `windows-x64`, `macos-arm64`, and
  `Publish installer to website` green; both homepage downloads and
  `/downloads/latest.json` must resolve without GitHub authentication.
- `npx wrangler d1 migrations list ourcord-service --remote` shows `0004…`
  applied; `ourcord-control` shows `0006…` applied.
- Smoke a device enroll → exchange → `/api/peers/config` round-trip, and a
  service lobby/room create, against the live URLs.
- Local pre-flight before deploying: `(cd control && pnpm run typecheck && pnpm test)`
  and the same in `service`.

## Rollback

- Code: re-run **Deploy** from a previous good commit (Workers keep versioned
  deployments; `wrangler rollback` can revert the last deploy immediately).
- Schema: migrations are forward-only. Additive columns/tables (the pattern used
  here) are backward-compatible, so rolling back code over a newer schema is
  safe; never write a destructive migration without a paired compatibility plan.
