# Database migrations: rules, release strategy and the upgrade rehearsal

Production (`main`) and development (`develop`) databases diverge while v0.2 is
being built — that is expected and fine. What keeps that divergence safe is a
single rule:

> **Every schema change ships as a committed Prisma migration.**
> A production upgrade must always be reproducible by running
> `prisma migrate deploy` against a copy of the real production schema.

## The rules

- Never manually change the production schema. No hand-run `ALTER TABLE`, no
  `prisma db push` against production or dev.
- Every schema change is made in `packages/database/prisma/schema.prisma` and
  captured with `prisma migrate dev --name <change>` **on develop**, and the
  generated SQL in `packages/database/prisma/migrations/` is committed.
- Do not assume an empty database. Migrations run against a production-size,
  production-shaped database — design for it.
- Never edit or delete an already-merged migration; add a new one.

## Expand / migrate / contract

Prefer three-phase changes so production keeps working at every point:

1. **Expand** — add new nullable columns, tables and indexes alongside the old
   structure. Old code keeps working; nothing existing breaks.
2. **Migrate** — switch code over to the new structure and backfill existing
   rows safely (batched updates inside the migration or a follow-up migration).
   Verify consistency.
3. **Contract** — only drop old columns/tables once no supported release still
   reads them. This phase usually lands late in the cycle or in the next
   release.

Avoid during 0.2.x development: dropping columns production still uses,
destructive renames without a backfill/compat step, destructive early cleanup
"because dev no longer needs it".

What moves from `develop` to `main` at release time: application code, the
Prisma schema, the migration files, and any backfill logic. **The dev database
itself never moves anywhere.**

## The required pre-release upgrade rehearsal

Before promoting `develop` -> `main` for a release (e.g. v0.2.0), prove the
migrations against a copy of the real production database:

```bash
# from the develop checkout
scripts/rehearse-prod-upgrade.sh --from-prod
```

The script:

1. Reads a `pg_dump` from the running production container (read-only;
   production is never written to).
2. Restores it into a throwaway `postgres:16-alpine` container on a
   localhost-only port (default 5433).
3. Applies all migrations from the current branch with
   `prisma migrate deploy`.
4. Compares table row counts before/after and flags any data loss.
5. Optionally (`START_API=1`) boots the built API image against the upgraded
   copy and probes `/api/ready`.
6. Tears everything down (`KEEP=1` keeps it for inspection).

Only if that rehearsal passes may production be upgraded — and production
should get a fresh backup taken immediately before the real deploy (see
"Backup and restore" below).

Note on encrypted data: stored Torn API keys are encrypted with
`API_KEY_ENCRYPTION_KEY`. A production copy restored into the dev stack can
only decrypt its keys with the **production** key; dev's own data uses dev's
key. Keep the two keys distinct and never persist the production key in the
dev env file — the rehearsal script passes it through to the throwaway API
container only, in memory, for the duration of the test.

## CI coverage: two paths that must both work

- **Clean install** — an empty database receives all migrations in order and
  ends up at the current schema. This is what CI's `verify` job proves on
  every push/PR (fresh Postgres service → `prisma migrate deploy` → tests).
- **Upgrade** — a realistic production database receives only the *new*
  migrations and ends up at the same schema. This cannot be meaningfully done
  with a committed fixture without shipping production data into the repo, so
  it is covered by the rehearsal script above, run from the server where the
  real dump lives. Run it before every release promotion.

`packages/database/tests/migration-safety.test.ts` adds standing regression
coverage for both: a destructive-operation guard over every migration added
after the production baseline (each future destructive change must be
allow-listed with a written compatibility plan or the suite fails), a
nullable-or-defaulted check for every added column, an inventory check that
pending-since-production migrations are listed here, and — when
`TEST_DATABASE_URL` points at a throwaway database — live `migrate deploy`
(idempotence) and `prisma validate` runs.

## v0.2 migration inventory (production 0.1.x → 0.2.0)

Production 0.1.x baseline = 20 migrations, latest applied
`20260909120000_sync_state_last_heartbeat_at` (verified read-only against the
production `_prisma_migrations` table). The complete v0.2 delta is:

| Migration | Classification | Notes |
|---|---|---|
| `20260909130000_sync_state_last_error_kind` | SAFE EXPAND | Adds nullable `SyncState.lastErrorKind` (machine reason of the last failure). No default, no backfill, no data touched — existing rows keep NULL ("unknown reason") until their next run writes a code. Operational-state derivation treats NULL as "no recorded reason". |
| `20260910200000_bars_snapshots` | SAFE EXPAND | Adds the new `BarsSnapshot` table (energy/happy bar history — Torn exposes bars live-only, so this history must be captured going forward). New table only: no existing table, column, or row is touched; fully additive. See docs/PROGRESSION-ENERGY.md. |
| `20260911180000_notification_events` | SAFE EXPAND | Notification platform v2 (roadmap #7): new `NotificationEvent` table (profile-level dedupe + quiet-hours deferral queue), nullable `NotificationDelivery` lifecycle columns (`eventId`, `reason`, `attempts`, `nextAttemptAt`, `lastError`), defaulted `NotificationPreference.bypassCritical` (true) + nullable `typeConfig`, nullable `NotificationState.systemState`. All additions: existing rows keep working unchanged. See docs/NOTIFICATIONS.md. |

There are **no destructive, rename, type-rewrite or NOT NULL-tightening
operations** in the v0.2 delta. `packages/database/tests/migration-safety.test.ts`
enforces that classification automatically for every future migration.

Pre-0.2 baseline history (all shipped to production between 2026-09-04 and
2026-09-09, all applied and verified there): `20260904000000_init` through
`20260909120000_sync_state_last_heartbeat_at` — see the migrations directory
for the full list; each was applied to production by its corresponding
production deploy.

## Dev data policy

- Dev/staging normally runs demo/synthetic data (`pnpm seed:demo`).
- A production copy may be restored into the dev stack **temporarily** for
  migration testing. Mark it clearly, keep the NPM access list on the dev
  domain, never let the dev worker sync these accounts against the live Torn
  API, and drop/reseed the dev database afterwards.
- The live production database is never a playground: no dev code, no dev
  worker, no experiments against it.

## Backup and restore

- Before every production deploy: `docker exec tornscope-postgres-1 pg_dump -U tornscope -d tornscope -Fc > /mnt/user/backups/tornscope/tornscope-pre-$(date +%Y%m%d-%H%M%S).dump`
- Restore drill (any dump): `pg_restore -U tornscope -d <target-db> --no-owner <dump>` — the same
  command path the rehearsal script uses, so restore capability is exercised
  regularly, not just assumed.
- Postgres data lives in `/mnt/user/appdata/tornscope/postgres` and is covered
  by normal appdata backups; the dev stack's data lives in
  `/mnt/user/appdata/tornscope-dev/postgres`.
