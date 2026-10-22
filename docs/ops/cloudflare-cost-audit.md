# Cloudflare resource audit (2026-10-22)

Scope: control/service Workers, D1/KV/R2 use, signaling Durable Objects,
maintenance jobs, and a read-through of desktop/daemon polling and the web
deployment configuration. No production resources or account settings were
changed. This is a code audit, not a reconciliation of actual account bills.

## Confirmed defects and fixes

| Priority | Trigger and previous behavior | Fix and regression evidence |
| --- | --- | --- |
| High | Concurrent file initiations all passed a separate `COUNT`, exceeding the lobby quota. Lobby owners could also select unlimited retention/count policies without an operator R2 cap. | Conditional D1 insert reserves the slot atomically. A trigger-maintained global byte/file reservation counter enforces operator limits across lobbies. `service/src/r2Budget.test.ts` exercises concurrent initiations against real SQLite. |
| High | Deleting a room/lobby cascaded away file metadata while retaining billable R2 objects. Hourly cleanup could never discover those keys again. | File deletion atomically enqueues R2 keys in a table without parent FKs. Failed object deletion retains the key and its capacity reservation. Cascade/retry tests cover this. |
| High | Two PUTs could read the same pending row and both write R2. A pending permanent reservation had no upload expiry. | A conditional upload claim admits one PUT; reservations expire after 30 minutes. Stalled uploads are aborted after 10 minutes. Cleanup waits until 11 minutes after an upload starts, preventing a late PUT from recreating an already-cleaned object. |
| High | Every rate-limited request performed a KV get/put. Counters were non-atomic, and fast requests could exceed KV's same-key write limit. Rejected/abusive traffic generated storage work. | Native rate-limit bindings replace KV counters. Missing production bindings return 503. OAuth, configuration, relay registration, public status, presence, upload/completion/download, and manual backend probes have guards before downstream work. |
| Medium | `server.accept()` kept signaling objects resident with open sockets. A delayed close/message from a superseded socket could remove or impersonate the replacement session. | Hibernatable WebSockets use attachments for session/bucket state and bounded SQLite replay storage. Runtime callbacks check socket identity. Reconstruction, replay, reconnect and native runtime tests cover the new path. |
| Medium | A user could combine an owned key with random peer keys to allocate arbitrary pair DOs; the signal route also omitted the user-ban check used by normal authenticated handlers. | Both pair peers must exist; user bans are checked before DO allocation. Ordinary HTTP requests are rejected before DB work. Room fan-out is capped at 64 sessions. |
| Medium | Backend probes had no timeout and left response bodies unread; a stalled backend could hold up maintenance or occupy fetch connections. | Five-second fetch deadlines and response-body cancellation bound probes; external upload verification also has a deadline. |

An additional regression fix freezes the clock in the existing desktop login
cooldown test. Its exact 60-second assertion otherwise intermittently observed
59 seconds when the test crossed a wall-clock second.

## Deployment and limits

1. Apply service migration `0006_r2_budget_cleanup.sql` **before** deploying the
   service Worker. It initializes `r2_usage` from existing file records and
   backfills upload deadlines on old pending rows. Do not delete the usage row
   or manually remove queue entries: that releases reservations without
   confirming physical deletion.
2. Deploy the control and service configurations together with their code.
   Native rate-limit namespace IDs are account-scoped; this repository uses
   `11005/11010/11020/11030/11060/11120` for control and
   `12005/12010/12020/12030/12060/12120` for service. Reserve those IDs for this
   application or choose unused IDs in both deployment configurations.
3. Operator R2 defaults are 10 GiB total, 1,000 files, and 100 MiB per file:
   `R2_MAX_BYTES`, `R2_MAX_FILES`, and `R2_MAX_FILE_BYTES`. Counts include
   pending uploads and objects queued for deletion. Lobby policies can be more
   restrictive. Setting `R2_MAX_BYTES=0` rejects new R2 reservations; it does
   not delete files or interrupt existing reservations. Lowering a cap below
   current usage similarly blocks new reservations until usage falls.
4. The service cron runs hourly. Each invocation processes at most 200 expired
   R2 records, 200 expired reservations, 200 failed uploads, and 200 queued
   object deletions. Failed object deletions are deferred to the next hour so
   one bad key cannot indefinitely occupy the front of the queue.
5. `limits.cpu_ms=50` bounds CPU per invocation. It does not limit aggregate
   requests, subrequest/storage operations, or total account spend. Validate
   CPU headroom against production traffic before increasing this value.

Useful read-only D1 checks after deployment:

```sql
SELECT * FROM r2_usage;
SELECT COUNT(*) AS queued_files, COALESCE(SUM(size_bytes), 0) AS queued_bytes,
       MIN(not_before) AS next_cleanup_at
FROM r2_deletion_queue;
SELECT upload_status, COUNT(*) AS n
FROM files WHERE storage_location = 'r2' GROUP BY upload_status;
```

The accounting invariant is:

```text
r2_usage = R2 file reservations still in files + entries in r2_deletion_queue
```

Queue deletion must follow successful R2 deletion. The queue outlives its
parent records and waits past the request-body upload timeout. A late R2
completion refreshes or recreates the queue entry, and cleanup only removes
the generation it selected, so concurrent finalization is not lost.
Failed/abandoned external-backend metadata is also
retired, but service does not own or delete bytes on autonomous backends.

## Boundaries and follow-up operations

- Native rate limits are approximate and local to each Cloudflare location.
  They reduce expensive downstream work; they are not a globally exact quota
  or an account spending limit. Incoming Worker requests still count even
  when rejected. Configure account billing alerts and appropriate edge/WAF
  protections for public endpoints separately.
- The R2 budget covers objects tracked by the new accounting scheme. Objects
  orphaned **before** this migration have no remaining metadata to recover
  automatically. Reconcile an R2 inventory against `files.storage_key` plus
  `r2_deletion_queue.storage_key` before treating the counter as total bucket
  usage; confirm ownership and any in-flight uploads before removing old keys.
- Active signaling messages and 30-second stale-session alarms still do work.
  Offer/answer persistence uses SQLite writes to preserve the 30-second replay
  guarantee across hibernation. Hibernation is not a zero-cost guarantee for
  active or abusive connections. The replay cache is bounded to 256 entries.
- Existing OTP recipient counters still use KV and retain their documented
  concurrency limitation. The new IP guards do not turn those counters into
  atomic counters. D1 message history, lobby counts, and authenticated read
  traffic also have no account-wide monthly budget.
- No production latency, billing totals, WAF settings, or object inventory was
  measured. Local workerd tests verify runtime behavior, not production billing
  or a precise CPU-time allowance. Do not roll back service to code that bypasses
  upload claims while the new deletion/accounting scheme is in use.

## Regression commands

```sh
(cd control && pnpm install --frozen-lockfile && pnpm exec tsc --noEmit && pnpm test)
(cd service && pnpm install --frozen-lockfile && pnpm exec tsc --noEmit && pnpm test)
node tests/cloudflare-runtime.mjs
(cd relay && go build ./... && go vet ./... && go test -race ./...)
(cd daemon && go build ./... && go vet ./... && go test -race ./...)
(cd filebackend && go build ./... && go vet ./... && go test -race ./...)
go work sync
```

Use Node 24 and pnpm 9 as declared by the packages. The runtime suite builds
both Workers in temporary directories and uses Wrangler's pinned Miniflare
dependency. It applies real D1 migrations, exercises R2 streaming and cleanup,
verifies native rate-limit responses without KV writes, and exchanges messages
over hibernatable WebSockets. Vitest separately reconstructs SignalDO to test
restoration after eviction. CI runs the runtime suite as its own job.

The workerd test caught a platform difference worth preserving: D1
`meta.changes` includes trigger writes, so a successful file insertion changes
more than one row after adding the reservation trigger. Only zero means the
conditional reservation was rejected.

## Platform references

Retrieved on 2026-10-22 from Cloudflare's official documentation repository;
the public documentation host returned HTTP 403 in the audit environment.
Binding signatures were also checked against the pinned Workers types and
the published `@cloudflare/workers-types@5.20261022.1` package.

- [Native rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
