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
3. In GitHub repo settings add secrets `CLOUDFLARE_API_TOKEN` (Workers + D1 edit
   scope) and, if the token isn't account-scoped, `CLOUDFLARE_ACCOUNT_ID`.

## Deploy

Preferred: run the **Deploy** workflow (`workflow_dispatch`) with target
`both` / `service` / `control`. It installs deps, then per worker runs
`pnpm run migrate` (D1 `--remote`) followed by `pnpm run deploy`.

Manual equivalent (service first):
```bash
(cd service && pnpm run migrate && pnpm run deploy)
(cd control && pnpm run migrate && pnpm run deploy)
```

`pnpm run migrate` applies any un-applied migrations in `migrations/`. Recent
schema changes that ship this way: service `0004_internal_nonces` (replay guard)
and control `0006_peer_connectivity_flap` (path-flap columns) — both must be
applied before their new code runs.

## Verify after deploy

- `curl https://<control>/` and `https://<service>/` return healthy.
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
