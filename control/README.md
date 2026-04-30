# control

Cloudflare Workers control plane for ourcord (peer registration, STUN/relay
assignment, bans).

## Database migrations

Schema is managed by `wrangler d1 migrations`, with SQL files under
`migrations/`. The D1 binding is `DB` (see `wrangler.toml`,
`migrations_dir = "migrations"`).

Apply migrations:

```bash
cd control
npx wrangler d1 migrations apply DB --local    # local dev DB
npx wrangler d1 migrations apply DB --remote   # remote (production) DB
```

To add a new migration, create the next-numbered file
(`migrations/0002_<description>.sql`) and run apply again.

The `POST /api/admin/init-db` route no longer creates tables — it is reserved
for seed data only and currently returns
`{ ok: true, msg: "schema is managed via 'wrangler d1 migrations apply'" }`.

## Tests

```bash
npm test
```
