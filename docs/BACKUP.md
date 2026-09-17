# Backup & restore

TornScope's value is the history it collects — much of it **cannot be
recovered from Torn later** because Torn's log retention is limited. Back
it up.

## What must be backed up

| What | Why |
| --- | --- |
| PostgreSQL volume | All collected events, snapshots, preferences and delivery history |
| `.env` | `API_KEY_ENCRYPTION_KEY` and origin configuration |
| `API_KEY_ENCRYPTION_KEY` (in `.env`) | **Losing this key means stored Torn API credentials can no longer be decrypted.** Collected history survives, but every profile must re-connect its API key |

## Backup

```bash
docker compose exec postgres pg_dump -U tornscope tornscope | gzip > tornscope-$(date +%F).sql.gz
```

Keep a copy of your `.env` alongside the dump — a database restore without
the matching `API_KEY_ENCRYPTION_KEY` gives you history but no decryptable
API keys.

Schedule the dump (cron/systemd timer/Unraid User Scripts) rather than
running it by hand, and keep copies off the host.

## Restore

```bash
# start an empty database with the SAME .env (same POSTGRES_PASSWORD)
docker compose up -d postgres
gunzip -c tornscope-2026-09-17.sql.gz | docker compose exec -T postgres psql -U tornscope -d tornscope
docker compose up -d
```

Restore into the same TornScope version or newer — migrations are additive
and the `migrate` service brings the schema up to date on startup. Restoring
into an older TornScope version is not supported.

## Test your restore

A backup that has never been restored is a hypothesis. Rehearse the steps
above on a scratch machine or a throwaway compose project before you need
them. For production upgrade rehearsals see
[DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md).
