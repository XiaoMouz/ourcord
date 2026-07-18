# Fleet monitoring & the operator console

This guide covers the operator-facing view of running infrastructure: the
admin-gated fleet endpoint on control, the web console that reads it, and an
alert playbook built on the structured logs the Workers and relays already emit.

There is no metrics stack (Prometheus/OTel) — the data control already collects
from relay heartbeats and file-backend probes is surfaced directly.

## Who can see it

The fleet endpoint and console require a **control JWT whose user id is in
`ADMIN_USER_IDS`** (the same comma-separated allowlist that gates `/api/ban`).
A valid non-admin token returns `403`. There is no separate operator password;
sign in with the normal control OTP flow using an operator account.

## `GET /api/control/fleet`

Admin-only. Extends the unauthenticated `/api/control/status` counts with
per-relay detail and a file-backend health rollup. Handler: `control/src/ops.ts`.

```jsonc
{
  "status": "ok",
  "environment": "production",
  "counts": {
    "users": 42,            // total registered users
    "active_peers_5m": 7,   // peers with last_seen within 300s
    "active_relays": 3,     // active relays heartbeated within 120s
    "active_bans": 0        // bans with no expiry or expiry in the future
  },
  "relays": [
    {
      "id": "…", "region": "hk", "mode": "lobby",
      "hostname": "hk.example", "port": 443,
      "capacity_kbps": 10000,   // soft capacity hint the relay reports
      "active_conns": 4,        // from relay_load (heartbeat)
      "bytes_per_sec": 2048,    // from relay_load (heartbeat)
      "last_heartbeat": 1737000000,
      "reported_at": 1737000000,
      "healthy": true           // active == 1 && last_heartbeat > now-120
    }
  ],
  "backends": {                 // null if SERVICE_URL not wired / unreachable
    "total": 5, "healthy": 4, "unhealthy": 1, "unknown": 0,
    "unhealthy_backends": [
      { "id": "…", "name": "lobby-nas", "base_url": "https://…",
        "last_health_at": 1737000000, "last_health_error": "health returned 502" }
    ]
  },
  "ts": 1737000000000
}
```

Field sources:

- `relays` = `relay_servers` LEFT JOIN `relay_load` (control D1). `active_conns`
  / `bytes_per_sec` come from the relay's 10s heartbeat sampler
  (`relay/cmd/ourcord-relay/main.go`); a relay that registered but hasn't
  reported load yet shows zeros.
- `healthy` uses the **120s heartbeat window** — the same cutoff as the
  `active_relays` count, so both agree on "up".
- `backends` is fetched from the service layer over the signed internal channel
  (`GET /api/internal/backends/health-summary`, `service/src/opsBackends.ts`),
  aggregating `file_backends.health_status`. It is best-effort: a service blip
  yields `backends: null` rather than failing the whole view.

The endpoint never returns secrets — no WireGuard/DERP keys, device tokens,
JWTs, `upload_secret`, or owner attribution beyond region/mode.

## The web console (`/admin`)

`ui/web/app/admin/` is an operator dashboard served by the same Next.js/Cloudflare
site as the download page. It is `noindex` and reuses `daemon/pkg/client`-free —
it talks to control over plain HTTP (control CORS is `*`, and the bearer token
rides in a header, not a cookie).

Usage:

1. Open `/admin` on the deployed site (or `npm run dev` locally).
2. Enter the **Control 地址** (e.g. `https://control.example`) and the operator
   email, request an OTP, and sign in. The control URL is persisted in
   `localStorage`; the JWT lives in `sessionStorage` for the tab session only.
3. The console polls `/api/control/fleet` every 15s: counts, a relay table with
   health dot / connections / throughput / load% / heartbeat age, and the
   file-backend health summary. Load ≥ 80% and any unhealthy backend render in
   amber.

If sign-in succeeds but the fleet shows `403`, the account is authenticated but
not in `ADMIN_USER_IDS`.

## Alert playbook

No pager integration ships yet; these are the signals to watch via
`wrangler tail` (Workers) and the relay JSON logs (`docs/ops/internal-operations.md`).

| Symptom | Where to look | Likely cause / action |
|---|---|---|
| Relay row flips `healthy:false` (heartbeat age > 120s) | relay host logs; control `relay.register` events | Relay process down, network partition, or clock skew. Restart relay; confirm `--control-url`/`--auth-token`. |
| `active_relays` drops to 0 | control `/api/control/fleet` | No relay heartbeating — DERP/relay fallback unavailable. Bring up at least one lobby/rental relay. |
| Relay load% near/over 100 | fleet `bytes_per_sec` vs `capacity_kbps` | Sustained saturation. Add relay capacity or raise `--capacity-kbps`/per-conn `--limit-kbps` floor. |
| Backend in `unhealthy_backends` | service logs; `last_health_error` | File server unreachable or non-2xx on `/.well-known/ourcord-file-backend/health`. Uploads fall through the 自建→分享→大厅→R2 chain meanwhile. |
| Spikes in control `request.error` | `wrangler tail` control | Inspect the failing route; 500s carry a request_id. |

## Self-host quick reference

**Relay** (`relay/cmd/ourcord-relay`): register against control with
`--control-url`, `--auth-token` (operator credential = control `ADMIN_TOKEN`, or
a user JWT for personal relays), `--hostname`, and `--mode personal|lobby|rental`.
The relay heartbeats every 5 min and samples load every 10s; control treats it
as up for **120s** after the last heartbeat. See `docs/ops/internal-operations.md`
for log wiring.

**File backend** (`filebackend/cmd/ourcord-filebackend`): run with `--data-dir`
and a strong `--upload-secret` (empty = open backend, dev only), register it in
the service via `POST /api/backends`. Health is probed at
`/.well-known/ourcord-file-backend/health`; see `docs/ops/file-backend.md`.
