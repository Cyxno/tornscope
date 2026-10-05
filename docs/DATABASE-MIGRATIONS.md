# Database migrations: rules, release strategy and the upgrade rehearsal

Production (`main`) and development (`develop`) databases diverge between
releases — that is expected and fine. What keeps that divergence safe is a
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

Before promoting `develop` -> `main` for a release, prove the migrations
against a copy of the real production database:

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

| `20260911200000_user_role_default_user` | SAFE DEFAULT CHANGE | `User.role` default flips `owner` → `user` (fail-safe: a future `user.create` without an explicit role can no longer silently mint an owner). All runtime paths already pass explicit roles; existing rows are untouched. See docs/HOSTED-SECURITY.md. |
| `20260913180000_today_last_known` | SAFE EXPAND | New `TodayLastKnown` table (one cached live-status payload per profile) so `GET /api/today` can serve cold page loads immediately (stale-while-revalidate) instead of blocking on the serialized upstream Torn refresh. New standalone table only: no existing table, column, or row is touched; profile deletion cascades to the cached payload via FK `ON DELETE CASCADE`. |

| `20260928180000_goals` | SAFE EXPAND | New `Goal` table for TornScope 2.0 personal goals (metric/target/note/targetDate/status/achievedAt, BigInt target). New standalone table only: no existing table, column, or row is touched; profile deletion cascades via FK `ON DELETE CASCADE`. Goal analytics read EXISTING snapshot tables (`NetworthSnapshot`, `PersonalStatSnapshot`, `UserSnapshot`) — the table stores only user intent, never derived data. |

## 2.0 migration delta (1.0.4 production → 2.0.0)

One migration: `20260928180000_goals` (SAFE EXPAND, classified in the v0.2
inventory above). There are **no destructive, rename, type-rewrite or
NOT NULL-tightening operations** in the 2.0 delta. The migration is trivially
backward-compatible — the 1.0.x application never reads `Goal` — so rolling
back the app image after deploying the migration needs no data migration.

There are **no destructive, rename, type-rewrite or NOT NULL-tightening
operations** in the v0.2 delta. `packages/database/tests/migration-safety.test.ts`
enforces that classification automatically for every future migration.

Pre-0.2 baseline history (all shipped to production between 2026-09-04 and
2026-09-09, all applied and verified there): `20260904000000_init` through
`20260909120000_sync_state_last_heartbeat_at` — see the migrations directory
for the full list; each was applied to production by its corresponding
production deploy.

## Demo data lifecycle

The public demo (`demo@tornscope.local`, `isDemo = true`, user-scoped
`source='demo'` rows only) has two distinct paths:

- **Full seed** — `pnpm demo:seed` (database: `seed:demo`). Destructive:
  deletes and recreates the demo profile with 180 days of synthetic history,
  the signature day, faction/OC fixtures and the demo notification ledger.
  For initial setup and manual recovery only.
- **Incremental top-up** — `pnpm demo:topup` (database: `topup:demo`,
  `--force` ignores the throttle) and automatic in the worker's scheduler
  tick. Non-destructive: preserves the demo profile and extends history
  toward now.

Top-up properties:

- deterministic per UTC day bucket (hash-seeded RNG per family + day — no
  sequential state), so the same day generates identical rows in any window;
- idempotent: every row dedupes on its unique sourceRef / snapshot key;
  safe to run repeatedly; interrupted runs converge on rerun;
- self-throttled to once per 6 hours via the
  `demo_topup_watermark_at` AppSetting on the demo user; catch-up is
  bounded to 45 days (beyond that the log says a manual reseed is required);
  a current demo is a cheap no-op (two reads);
- pure DB generation: never calls the Torn API (guard-tested), never writes
  notifications/push, never touches real users or the global item catalog;
- wallet-ledger coherent: tracked wallet cash is derived from the recorded
  synthetic ledger (plus the demo's small documented drift), with bank
  withdrawals recorded in the ledger when cash would run dry;
- after success it refreshes the demo's synthetic SyncState health
  timestamps (deliberate: keeps the demo UI healthy; no real sync is
  implied) and advances the watermark.

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
- Postgres data lives in `/mnt/cache/appdata/tornscope/postgres` (direct pool path, shfs bypassed — see docs/ENVIRONMENTS.md storage policy) and is covered
  by normal appdata backups. There is no permanent dev stack; if a temporary
  environment is created for migration testing, its data directory is
  disposable and must be destroyed with the rest of that environment.

## 2.2/2.3 migration deltas (2.1.0 production → 2.3.1)

| Migration | Classification | Notes |
|---|---|---|
| `20261001196000_timeline_log_type_index` | SAFE EXPAND (index-only) | Composite index `TimelineEvent(userId, type, occurredAt)` for the Log Explorer and deep-analytics evidence queries. |
| `20261005175053_activity_events` | SAFE EXPAND | New `ActivityEvent` table (2.4.0 Activity & Rewards): semantic casino/openable activity normalization; no existing column or row is touched and profile deletion cascades via FK. Also three schema-convergence statements the generator produced against the declared Prisma schema: `ApiCredential.logAccessAvailable` drops its residual default (schema declares none), `NotificationDelivery.subscriptionId` gains its declared FK to `PushSubscription` (declared since 2.2 but never materialized), and the delivery unique index is renamed to Prisma's identifier (PostgreSQL had truncated the 2.2 name differently). All three are metadata-only, no data is read or rewritten. |

## 2.1 migration delta (2.0.7 production → 2.1.0)

One migration: `20261001196000_timeline_log_type_index` (SAFE EXPAND, index-only):

| Migration | Classification | Notes |
|---|---|---|
| `20261001196000_timeline_log_type_index` | SAFE EXPAND (index-only) | Adds composite index `TimelineEvent(userId, type, occurredAt)` backing the 2.1.0 Log Explorer and the deep-analytics evidence queries (filter + date range over the raw log archive). Pure `CREATE INDEX` — no table, column or row is touched; safe to build on production size. Every deep-analytics read path was measured on production data before release (page queries ≤0.25 ms at 30D/1Y/ALL; evidence queries ≤8 ms at 1Y). |

There are **no destructive, rename, type-rewrite or NOT NULL-tightening
operations** in the 2.1 delta.

## 2.5.0 migration delta (2.4.0 → 2.5.0)

None. The value-coverage expansion is schema-additive in the ActivityEvent
`metadata` JSON only: new domains (hunting/missions/racing/bounties/
education) and legacy casino rows store their payload and parsed extras in
the existing `metadata` column; no table, column or migration changes.
