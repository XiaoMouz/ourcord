# Internal Device And Log Operations

This guide is for the internal beta. It uses the existing device-token API and
local diagnostic archive; it does not require a desktop UI.

## Enroll a device

An enrollment binds one WireGuard public key to one user and returns a long
lived `dt_` device credential. The credential is stored only on that device as
`<state-dir>/device.token` with mode `0600`; the daemon exchanges it for short
lived JWTs automatically.

Obtain a fresh user JWT through the approved internal login flow, save it in a
mode-`0600` file, then run:

```bash
ourcord-cli enroll \
  --control-url https://control.internal.example \
  --state-dir ~/.local/share/ourcord \
  --user-token-file ~/.config/ourcord/enroll.jwt \
  --name "alice-macbook"
```

The command creates the local WireGuard key if needed, registers its public
key, writes `device.token`, and prints device metadata only. It never prints
the returned `dt_` secret. Delete the one-time JWT file after enrollment.

To inspect or revoke devices:

```bash
ourcord-cli devices --control-url https://control.internal.example \
  --user-token-file ~/.config/ourcord/enroll.jwt

ourcord-cli revoke-device <device-id> \
  --control-url https://control.internal.example \
  --user-token-file ~/.config/ourcord/enroll.jwt
```

Revocation is per-device: the daemon can no longer exchange that credential,
while other enrolled devices remain active.

## Runtime logs

`ourcordd` and `ourcord-relay` emit JSON Lines to stderr by default. Each entry
has `ts`, `level`, `component`, `event`, and `msg`. Device credentials, JWTs,
and Bearer values are redacted before they reach stderr or an optional log
file.

Use persistent service-manager logging in normal operation, or explicitly add
a file during internal investigations:

```bash
ourcordd --log-level info --log-format json \
  --log-file /var/log/ourcord/daemon.jsonl

ourcord-relay --log-level info --log-format json \
  --log-file /var/log/ourcord/relay.jsonl
```

The Worker control and service layers already emit structured JSON through
Cloudflare's runtime logs. Use the Cloudflare dashboard or `wrangler tail` for
the matching Worker during an incident. Do not add JWTs, device tokens,
upload secrets, Authorization headers, or private keys to a log field.

## Collect a support bundle

Ask the user to run this locally after a failure:

```bash
ourcord-cli diagnostics collect \
  --socket /tmp/ourcordd.sock \
  --log-file /var/log/ourcord/daemon.jsonl \
  --output ourcord-diagnostics.zip
```

The ZIP is mode `0600` and includes the daemon status, peer/path state, a
platform manifest, and the final 512 KiB of the selected daemon log. The log
is redacted again while archiving. It intentionally excludes WireGuard private
keys, DERP private keys, `device.token`, JWTs, and IPC HMAC keys.
