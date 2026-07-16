# Security

This document describes the OurCord security model: who we trust, which secrets
exist, how trust boundaries are enforced, how to rotate credentials, and what
known gaps are scheduled for future work.

It is descriptive of the current implementation. Items explicitly marked
**future** are not yet implemented and must not be assumed to be in place.

---

## 1. Threat model

### Trusted

- **The Cloudflare runtime.** The control and service layers run as Cloudflare
  Workers. Worker secrets (`wrangler secret put`) are encrypted at rest and
  only decrypted inside the isolate. We trust Cloudflare's tenant isolation,
  TLS termination, and KV/D1/R2 access control.
- **Daemon owners on their own machine.** The daemon (`daemon/`) runs locally
  on a user's device. It holds a long-lived per-device token in
  `<state-dir>/device.token` (mode `0600`) or via `OURCORD_DEVICE_TOKEN`;
  the legacy `<state-dir>/token` / `OURCORD_DAEMON_JWT` path remains for
  compatibility. We trust that the local user controls their own machine;
  we do not defend against an attacker with root on the user's host.
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
| `SERVICE_INTERNAL_TOKEN` | Worker secret on **control** + **service** (must match) | `wrangler secret put` on both workers | Shared HMAC key for control→service internal RPC. Control sends `X-Internal-Ts`, `X-Internal-Nonce`, and `X-Internal-Sig`; the secret is not sent as a bearer. Used by routes such as control's peer-config builder when fetching room membership from service. |
| `EMAIL_API_KEY` | Worker secret on **control** | `wrangler secret put` | Resend API key used to deliver OTP email. Absent in dev; production fails closed (503) rather than logging the OTP. |
| `ADMIN_USER_IDS` | Worker secret on **control** | `wrangler secret put` | Comma-separated user-id allowlist consulted by `requireAdmin` (e.g. ban management). Not a credential per se, but treated as a secret to avoid leaking the admin set. |
| OAuth client secret(s) | Worker secret on **control** | `wrangler secret put` (per provider) | Used when `oauthRedirect`/`oauthCallback` is enabled. Not exposed to clients. |
| Daemon device token | Local file `<state-dir>/device.token` (mode `0600`) **or** `OURCORD_DEVICE_TOKEN` env | Enroll/exchange/revoke through control device APIs | Long-lived per-device secret (`dt_...`) stored client-side and hashed in control D1. The daemon exchanges it for short-lived control auth, allowing single-device revocation. |
| Legacy daemon JWT | Local file `<state-dir>/token` (mode `0600`) **or** `OURCORD_DAEMON_JWT` env | Re-issued via the legacy login/control flow | Compatibility fallback. The daemon presents it as `Authorization: Bearer …` and as `?token=` for the WebSocket signal upgrade. Prefer device tokens for new flows. |
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

- **Auth**: HMAC-SHA256 short signature using `SERVICE_INTERNAL_TOKEN`
  as the shared key. Control sends `X-Internal-Ts`,
  `X-Internal-Nonce`, and `X-Internal-Sig`, where the signature covers
  `ts\nnonce\nMETHOD\npathname+search`.
- **Verification**: service checks a ±90s timestamp window, uses constant-time
  signature comparison, and records the nonce with `INSERT OR IGNORE` in the
  strongly consistent D1 `internal_nonces` table. A per-isolate map is only a
  fast negative cache. The old static `X-Internal-Token` bearer shape is
  rejected.
- **Transport**: HTTPS, Cloudflare → Cloudflare.
- **Residual risk**: if the D1 nonce insert errors, verification deliberately
  degrades to the per-isolate cache so a transient D1 outage does not break all
  room-scoped config calls. Cross-isolate replay is therefore theoretically
  possible during that degraded window. A Cloudflare account compromise or
  malicious deploy remains out of scope for this layer.

### 3.4 Daemon ↔ Control

- **Auth**: preferred path is a per-device token loaded from
  `OURCORD_DEVICE_TOKEN` or `<state-dir>/device.token`, exchanged with
  control for short-lived control auth. The legacy raw JWT path via
  `OURCORD_DAEMON_JWT` or `<state-dir>/token` remains for compatibility.
- **Signal upgrade**: HTTP uses `Authorization: Bearer …`; WebSocket
  signaling still uses `?token=…` because browsers cannot set headers on
  upgrade and the daemon mirrors that path.
- **Transport**: HTTPS / WSS.
- **Scope**: device tokens can be revoked independently without rotating
  all of a user's sessions.

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

### 3.7 Voice media (peer ↔ peer)

- **Why extra crypto**: voice is UDP on the VPN overlay, and an A-B-C relay
  hop (peer B) kernel-forwards the inner packets in the clear at the
  WireGuard layer. B may not even be in the call, so relying on WG-hop
  encryption would expose the audio to the relay.
- **Scheme** (`daemon/pkg/media/crypto.go`): a pairwise key is derived with no
  extra signaling from the WireGuard static keys both ends already hold —
  `X25519(ourWgPriv, peerWgPub) → HKDF-SHA256 → ChaCha20-Poly1305`. The RTP
  header is authenticated as AEAD additional data; the payload is sealed; a
  monotonic counter + 64-entry replay window prevent replay. Each peer stream
  has its own key, so a relay holding only `pairKey(A,B)` cannot read the
  forwarded `A→C` datagram (asserted by unit tests and the netns acceptance's
  voice-over-relay stage).
- **Known gap — no PFS (v1)**: the pairwise key is static for the life of the
  WireGuard keys, so a compromise of a device's WG private key retro-decrypts
  captured audio. The planned follow-up is an ephemeral rekey negotiated inside
  the encrypted pairwise channel.

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

### 4.2 `SERVICE_INTERNAL_TOKEN` HMAC key

Rotation today is a hard cutover (rotate both Workers as fast as
possible; expect a small window of 401s on internal RPC). The intended
follow-up is a dual-token rolling rotation:

1. Both control and service accept **either** `SERVICE_INTERNAL_TOKEN`
   or `SERVICE_INTERNAL_TOKEN_OLD` on the verifying side, and prefer
   `SERVICE_INTERNAL_TOKEN` on the sending side.
2. To rotate:
   - set `SERVICE_INTERNAL_TOKEN_OLD = <current value>` on both Workers;
   - set `SERVICE_INTERNAL_TOKEN = <new value>` on both Workers;
   - deploy.
3. After at least 7 days of clean logs (no observed use of the old
   value), unset `SERVICE_INTERNAL_TOKEN_OLD` on both Workers.

> **Status**: HMAC signing is implemented. Dual-token overlap is not yet
> implemented; the current code accepts only one key.

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

- Daemon: prefer device-token enroll/exchange/revoke. The daemon picks
  up a new device token on next start (or via `OURCORD_DEVICE_TOKEN`).
  Legacy raw JWT rotation still uses `OURCORD_DAEMON_JWT` or
  `<state-dir>/token`.
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
  Same atomicity caveat as above; moving this counter to D1 or a Durable Object
  remains future hardening.
- **WebSocket signalling**: per-session rate limits applied in
  `control/src/signal.ts`; offending sockets are closed with
  `1008 "rate limit exceeded"`.

---

## 6. Known gaps and future work

- **Fail-closed policy for nonce-store outages.** D1 is the normal
  cross-isolate replay guard, but verification currently falls back to the
  isolate-local cache when D1 errors. High-assurance deployments may prefer to
  reject internal calls until D1 recovers.

- **Dual-key rotation for `SERVICE_INTERNAL_TOKEN`.** HMAC currently uses
  one active key. Add `SERVICE_INTERNAL_TOKEN_OLD`/key-id overlap before
  relying on zero-downtime internal-key rotation.

- **Device credential polish.** Per-device enroll/exchange/revoke exists;
  remaining work is operator-facing audit/rotation UX and removal of the
  legacy raw JWT daemon path once clients have migrated.

- **End-to-end encryption.**
  - **Voice media** has the additional pairwise E2E layer described in §3.7,
    so an A-B-C forwarding peer cannot read it. Video and screen-share are not
    implemented yet and must preserve this property when their contracts land.
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
