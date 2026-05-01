# Security

This document describes the OurCord security model: who we trust, which secrets
exist, how trust boundaries are enforced, how to rotate credentials, and what
known gaps are scheduled for future work.

It is descriptive of the current implementation. Items explicitly
marked **future** or **phase-2** are not yet implemented and must not be
assumed to be in place.

---

## 1. Threat model

### Trusted

- **The Cloudflare runtime.** The control and service layers run as Cloudflare
  Workers. Worker secrets (`wrangler secret put`) are encrypted at rest and
  only decrypted inside the isolate. We trust Cloudflare's tenant isolation,
  TLS termination, and KV/D1/R2 access control.
- **Daemon owners on their own machine.** The daemon (`daemon/`) runs locally
  on a user's device. It holds a long-lived auth token in
  `<state-dir>/token` (mode `0600`) or via `OURCORD_DAEMON_JWT`. We trust
  that the local user controls their own machine; we do not defend against
  an attacker with root on the user's host.
- **Operators of relay nodes (`relay/`)** with respect to traffic visibility:
  relays see ciphertext only (WireGuard / DERP frames) and metadata
  (peer pairs, packet sizes, timing). Relay operators are trusted not to
  perform large-scale traffic analysis, but cannot read media or message
  content even if they wanted to.

### Untrusted

- **The rest of the internet.** All public endpoints assume hostile callers:
  request bodies are size-checked, JWTs are verified, rate limits apply.
- **Other users in the same lobby/room** unless explicitly added as a peer.
  Lobby membership grants signalling and message-history access for that
  lobby only; it does not grant network-layer access. WireGuard peer
  relationships are the actual authorization for P2P traffic.
- **Anyone holding a stolen token** within its TTL. We mitigate via short
  JWT TTL (1h, see X1) and a `bans` table check on every `requireAuth`.

---

## 2. Secrets inventory

| Name | Where stored | Rotated by | Scope |
|---|---|---|---|
| `JWT_SECRET` | Worker secret on **control** + **service** (must match) | `wrangler secret put` on both workers | HMAC-SHA256 key used to sign and verify user JWTs. Must be ≥16 bytes (production enforces ≥16; ≥32 recommended via `openssl rand -base64 48`). |
| `ADMIN_TOKEN` | Worker secret on **service** | `wrangler secret put` | Shared bearer for one-shot service-side admin endpoints (e.g. R2 cleanup). Constant-time compared (see `service/src/index.ts` J4 note). |
| `SERVICE_INTERNAL_TOKEN` | Worker secret on **control** + **service** (must match) | `wrangler secret put` on both workers | Shared bearer that authenticates control→service internal RPC. Sent as the `X-Internal-Token` request header. Used by routes such as control's peer-config builder when fetching room membership from service. |
| `EMAIL_API_KEY` | Worker secret on **control** | `wrangler secret put` | Resend API key used to deliver OTP email. Absent in dev; production fails closed (503) rather than logging the OTP. |
| `ADMIN_USER_IDS` | Worker secret on **control** | `wrangler secret put` | Comma-separated user-id allowlist consulted by `requireAdmin` (e.g. ban management). Not a credential per se, but treated as a secret to avoid leaking the admin set. |
| OAuth client secret(s) | Worker secret on **control** | `wrangler secret put` (per provider) | Used when `oauthRedirect`/`oauthCallback` is enabled. Not exposed to clients. |
| Daemon auth token | Local file `<state-dir>/token` (mode `0600`) **or** `OURCORD_DAEMON_JWT` env | Re-issued via `ourcord-cli login` (control flow) | Long-lived bearer the daemon presents to control as `Authorization: Bearer …` (and as `?token=` for the WebSocket upgrade in `daemon/pkg/control/client.go`). Currently per-user, not per-device. |
| Relay auth token | CLI flag `--auth-token` (or operator-supplied env wrapping it) | Re-issued by control operator | Bearer the relay presents to control as `Authorization: Bearer …` when registering itself and reporting health. |

---

## 3. Trust boundaries

### 3.1 User ↔ Control

- **Auth**: JWT signed with `JWT_SECRET` (HMAC-SHA256), 1h TTL (X1).
- **Issuance paths**: `verifyOTP` and `oauthCallback`. Both call
  `isUserBanned` before issuing a token (X1).
- **Verification path**: `requireAuth` re-verifies signature and TTL on
  every request, and re-runs `isUserBanned` so that banning a user
  invalidates outstanding tokens immediately rather than waiting for TTL
  expiry (see `control/AGENTS.md` P3).
- **Transport**: HTTPS terminated by Cloudflare.

### 3.2 User ↔ Service

- Same JWT as §3.1; same `JWT_SECRET`. Service re-verifies via
  `service/src/auth.ts` `requireAuth`.
- The service is a separate Worker but shares the JWT_SECRET so that no
  token re-issuance is needed when crossing the boundary.

### 3.3 Control ↔ Service (internal RPC)

- **Auth**: bearer `SERVICE_INTERNAL_TOKEN` carried in the
  `X-Internal-Token` request header. Constant-time compared on the
  service side.
- **Transport**: HTTPS, Cloudflare → Cloudflare.
- **Risk profile**: this is a shared symmetric secret, not an HMAC over
  the request. We accept this for phase-1 because:
  - both endpoints are Cloudflare Workers with secrets encrypted at rest;
  - the secret never leaves Cloudflare's runtime (it is not handed to
    clients, daemons, or relays);
  - there is no replay window we care about — internal RPCs are
    idempotent reads (e.g. room membership lookup) and revocation is
    achieved by rotating the secret.
- **What this does not protect against**: a Cloudflare account compromise
  or a malicious deploy that exfiltrates the secret. Both are out of
  scope for this layer; the planned HMAC scheme in §6 narrows the blast
  radius but does not change the trust model.

### 3.4 Daemon ↔ Control

- **Auth**: the per-user JWT issued by control, loaded from
  `OURCORD_DAEMON_JWT` env or `<state-dir>/token` file. Sent as
  `Authorization: Bearer …` for HTTP and as `?token=…` query parameter
  for the WebSocket signal upgrade (browsers cannot set headers on
  upgrade, so the daemon mirrors that path; see
  `daemon/pkg/control/client.go`).
- **Transport**: HTTPS / WSS.
- **Scope**: the daemon currently presents the user's JWT, not a
  device-bound credential (see §6).

### 3.5 Daemon ↔ Relay

- The daemon talks DERP to the relay. The relay forwards encrypted
  WireGuard frames; it has no per-user authentication of its own.
  Authorization to be on the network is decided at the WireGuard layer
  (the relay only carries packets between peers that already share keys).

### 3.6 Relay ↔ Control

- **Auth**: bearer relay token (`--auth-token`), sent as
  `Authorization: Bearer …` from `relay/pkg/controlclient/client.go`.
- **Transport**: HTTPS.
- **Scope**: identifies the relay node when registering itself and
  reporting capacity / health to control.

---

## 4. Rotation strategy

### 4.1 `JWT_SECRET`

```
# control + service must rotate together
echo "$NEW_SECRET" | npx wrangler secret put JWT_SECRET   # in control/
echo "$NEW_SECRET" | npx wrangler secret put JWT_SECRET   # in service/
```

- All outstanding JWTs are invalidated immediately on the first
  Worker isolate that picks up the new secret.
- Disruption is bounded by the 1h JWT TTL (X1): in the worst case a
  user re-authenticates once. There is no long-lived session to repair.
- Do not rotate one side without the other — users will see
  intermittent 401s as requests fan out across isolates.

### 4.2 `SERVICE_INTERNAL_TOKEN` (dual-token rolling rotation — **future**)

Phase-1 rotation today is a hard cutover (rotate both Workers as fast
as possible; expect a small window of 401s on internal RPC). The
intended phase-2 procedure is a dual-token rolling rotation:

1. Both control and service accept **either** `SERVICE_INTERNAL_TOKEN`
   or `SERVICE_INTERNAL_TOKEN_OLD` on the verifying side, and prefer
   `SERVICE_INTERNAL_TOKEN` on the sending side.
2. To rotate:
   - set `SERVICE_INTERNAL_TOKEN_OLD = <current value>` on both Workers;
   - set `SERVICE_INTERNAL_TOKEN = <new value>` on both Workers;
   - deploy.
3. After at least 7 days of clean logs (no observed use of the old
   value), unset `SERVICE_INTERNAL_TOKEN_OLD` on both Workers.

> **Status**: not yet implemented. The current code accepts only one
> value. Tracking this alongside the HMAC migration in §6.

### 4.3 `ADMIN_TOKEN`

Rotated ad-hoc with `wrangler secret put ADMIN_TOKEN` on the service
Worker. Disruption is negligible: this token is only used by one-shot
operator endpoints (e.g. R2 cleanup), not by user traffic.

### 4.4 `EMAIL_API_KEY`

Rotated at the email provider (Resend), then `wrangler secret put
EMAIL_API_KEY` on control. Failed deliveries surface as 503 from
`/api/auth/otp/request`; no OTP is ever logged on the failure path in
production.

### 4.5 OAuth client secrets

Rotated at the OAuth provider, then `wrangler secret put` of the
matching variable on control. In-flight OAuth callbacks during the
rotation window will fail; users retry the login.

### 4.6 Daemon and relay tokens

- Daemon: `ourcord-cli login` re-issues; the daemon picks up the new
  token on next start (or via `OURCORD_DAEMON_JWT`).
- Relay: operator restarts the relay process with a new `--auth-token`.
  The control side considers the relay re-registered.

---

## 5. Rate limits and abuse

- **Per-IP KV rate limiter (X6)** on hot routes. Implemented in
  `control/src/ratelimit.ts` and `service/src/ratelimit.ts`; exposed via
  `checkRateLimit(request, env, bucket, limit, windowSec)`. Examples:
  - `POST /api/auth/otp/request`: 5 per 60 s per IP.
  - `POST /api/auth/otp/verify`: 10 per 60 s per IP.
  Counters are KV-based and therefore best-effort under burst load
  (read-modify-write is not atomic). Acceptable: the goal is to make
  abuse expensive, not perfectly bounded.
- **Per-recipient OTP daily quota**: configurable via
  `EMAIL_RATE_LIMIT_PER_DAY` (default 10). Exhausting the quota causes
  `sendOTPEmail` to throw and the request to return 503. The OTP is
  never echoed in the error response.
- **OTP brute-force protection (P2)**: `otp_fails:<email>` KV counter
  invalidates the OTP after `OTP_MAX_FAILS = 5` wrong submissions;
  `otp_cooldown:<email>` enforces a 60 s cooldown between issuances.
  Same atomicity caveat as above; phase-2 will move this to D1 or a
  Durable Object.
- **WebSocket signalling**: per-session rate limits applied in
  `control/src/signal.ts`; offending sockets are closed with
  `1008 "rate limit exceeded"`.

---

## 6. Known gaps and future work

- **HMAC for control ↔ service.** Phase-2 will replace the bearer
  `SERVICE_INTERNAL_TOKEN` with an HMAC scheme so that a leaked secret
  cannot be replayed against arbitrary requests. Planned wire format:

  ```
  Authorization: HMAC-SHA256 <kid>:<nonce>:<sig>
  ```

  where `<kid>` selects the key (enabling overlap with the dual-token
  rotation in §4.2), `<nonce>` is a per-request value bound into the
  signature, and `<sig>` covers method, path, body hash, and timestamp.
  **Not implemented now.** Do not build clients against this format yet.

- **Per-device JWT.** The daemon currently presents the user's JWT.
  Phase-2 will introduce per-device credentials so that revoking a
  single device does not require rotating the user's web session, and
  so that device-level audit logging becomes possible.

- **End-to-end encryption.**
  - **Room media (audio/video/screen-share)** is end-to-end at the
    WireGuard layer: peers exchange Curve25519 keys and traffic is
    encrypted with ChaCha20-Poly1305. Relays carry ciphertext only.
  - **Message text routed through the service layer** falls back to
    TLS only — i.e. the service is trusted with plaintext for the
    purpose of storing message history. Adding E2EE for stored messages
    is not currently planned; users who need it should treat the
    service as a trusted store.

---

## 7. Reporting a vulnerability

If you believe you have found a security issue, please report it
privately rather than opening a public GitHub issue. Two channels:

- **GitHub Security Advisories**: open a draft advisory on this
  repository (Security tab → "Report a vulnerability"). This is the
  preferred channel; it lets us collaborate on a fix in private.
- **Email**: `security@ourcord.invalid` (placeholder — replace with the
  project's published address before public release).

Please include:

- a description of the issue and its impact;
- steps to reproduce, or a proof-of-concept;
- the affected component (`control/`, `service/`, `daemon/`, `relay/`,
  `ui/`) and commit SHA if known;
- whether you intend to disclose publicly, and on what timeline.

We will acknowledge reports within a reasonable timeframe and aim to
ship a fix or mitigation before any public disclosure.
