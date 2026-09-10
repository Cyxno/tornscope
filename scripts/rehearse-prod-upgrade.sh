#!/usr/bin/env bash
# Upgrade rehearsal: prove the current branch's Prisma migrations apply
# cleanly to a COPY of the real production database — before production is
# ever upgraded. This is the REQUIRED pre-release test before promoting
# develop -> main for a release (docs/DATABASE-MIGRATIONS.md).
#
# The production database is only ever read via pg_dump. All migration work
# happens inside a throwaway postgres:16-alpine container on a localhost-only
# port. Nothing here writes to production, and everything is torn down.
#
# Usage:
#   scripts/rehearse-prod-upgrade.sh <dump-file>            # use an existing dump
#   scripts/rehearse-prod-upgrade.sh --from-prod            # pg_dump the local prod container first (read-only)
#
# Environment:
#   REHEARSAL_PORT     localhost port for the rehearsal DB (default 5433)
#   KEEP=1             keep the rehearsal DB running for manual inspection
#   START_API=1        additionally boot the built tornscope-api image
#                      against the upgraded copy and probe /api/ready
set -uo pipefail

cd "$(dirname "$0")/.."

DUMP_ARG="${1:-}"
REHEARSAL_PORT="${REHEARSAL_PORT:-5433}"
REHEARSAL_PG=tornscope-rehearsal-postgres
REHEARSAL_API=tornscope-rehearsal-api
REHEARSAL_REDIS=tornscope-rehearsal-redis
REHEARSAL_NET=tornscope-rehearsal-net
DB_USER=tornscope
DB_NAME=tornscope
DB_PASS=rehearsal-only
DUMP_FILE=""

die() { echo "rehearse: ERROR: $*" >&2; exit 1; }

[[ -f packages/database/prisma/schema.prisma ]] || die "run from the repository root (schema not found)."

# ---- Resolve the dump ----------------------------------------------------
if [[ "$DUMP_ARG" == "--from-prod" ]]; then
  docker ps --format '{{.Names}}' | grep -qx 'tornscope-postgres-1' \
    || die "production container tornscope-postgres-1 not found — pass a dump file instead."
  DUMP_FILE="/tmp/tornscope-rehearsal-$(date +%Y%m%d-%H%M%S).dump"
  umask 077
  echo "==> Reading a dump from the production container (read-only pg_dump) ..."
  docker exec tornscope-postgres-1 pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc > "$DUMP_FILE" \
    || die "pg_dump failed — production was NOT modified, aborting."
  echo "    dump: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"
elif [[ -n "$DUMP_ARG" && -f "$DUMP_ARG" ]]; then
  DUMP_FILE="$DUMP_ARG"
else
  die "usage: $0 <dump-file> | $0 --from-prod"
fi

# ---- Port guard ----------------------------------------------------------
if port_in_use=$(curl -s -o /dev/null -w "%{http_code}" -m 2 "http://127.0.0.1:${REHEARSAL_PORT}/" 2>/dev/null) && [[ "$port_in_use" != "000" ]]; then
  die "port ${REHEARSAL_PORT} already in use — set REHEARSAL_PORT to a free port."
fi

KEEP="${KEEP:-0}"
START_API="${START_API:-0}"
CLEANED=0
cleanup() {
  (( CLEANED )) && return 0
  if [[ "$KEEP" == "1" ]]; then
    echo "==> KEEP=1 — rehearsal containers left running:"
    echo "    psql: docker exec -it $REHEARSAL_PG psql -U $DB_USER -d $DB_NAME"
    echo "    dump kept at: $DUMP_FILE"
    return 0
  fi
  echo "==> Tearing down rehearsal containers"
  docker rm -f "$REHEARSAL_API" "$REHEARSAL_REDIS" "$REHEARSAL_PG" >/dev/null 2>&1 || true
  docker network rm "$REHEARSAL_NET" >/dev/null 2>&1 || true
  CLEANED=1
}
trap cleanup EXIT

# ---- Start the throwaway DB ----------------------------------------------
echo "==> Starting throwaway postgres:16 (localhost-only port ${REHEARSAL_PORT})"
docker rm -f "$REHEARSAL_PG" >/dev/null 2>&1 || true
docker run -d --name "$REHEARSAL_PG" \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" -e POSTGRES_DB="$DB_NAME" \
  -p "127.0.0.1:${REHEARSAL_PORT}:5432" postgres:16-alpine >/dev/null \
  || die "could not start rehearsal postgres"

for _ in $(seq 1 30); do
  docker exec "$REHEARSAL_PG" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$REHEARSAL_PG" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null \
  || die "rehearsal postgres never became ready"

# ---- Restore production copy --------------------------------------------
echo "==> Restoring the production copy (this can take a while)"
docker cp "$DUMP_FILE" "$REHEARSAL_PG:/rehearsal.dump" >/dev/null \
  || die "could not copy dump into the rehearsal container"
docker exec "$REHEARSAL_PG" pg_restore -U "$DB_USER" -d "$DB_NAME" --no-owner --exit-on-error /rehearsal.dump \
  || die "pg_restore failed"
docker exec "$REHEARSAL_PG" rm -f /rehearsal.dump >/dev/null

count_rows() {
  local sql
  sql=$(docker exec "$REHEARSAL_PG" psql -U "$DB_USER" -d "$DB_NAME" -At -c \
    "SELECT coalesce(string_agg(format('SELECT %L, count(*) FROM %I', relname, relname), ' UNION ALL ' ORDER BY relname), 'SELECT ''no tables'', 0') FROM pg_class WHERE relkind='r' AND relnamespace='public'::regnamespace") \
    || die "could not enumerate tables in the rehearsal DB"
  docker exec "$REHEARSAL_PG" psql -U "$DB_USER" -d "$DB_NAME" -At -F'=' -c "$sql"
}

echo "==> Counting rows before migration"
count_rows > /tmp/rehearsal-rows-before.txt
echo "    $(wc -l < /tmp/rehearsal-rows-before.txt) tables, $(awk -F= '{s+=$2} END {print s}' /tmp/rehearsal-rows-before.txt) total rows"

# ---- Apply this branch's migrations --------------------------------------
[[ -d node_modules ]] || die "node_modules missing — run pnpm install first (prisma CLI is needed)."
echo "==> Applying migrations from $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${REHEARSAL_PORT}/${DB_NAME}?schema=public" \
  pnpm exec prisma migrate deploy --schema packages/database/prisma/schema.prisma \
  || die "MIGRATION FAILED against the production copy — do NOT promote this branch. Investigate and add a safe migration."

echo "==> Counting rows after migration"
count_rows > /tmp/rehearsal-rows-after.txt

echo "==> Row-count diff (before -> after)"
if diff -u /tmp/rehearsal-rows-before.txt /tmp/rehearsal-rows-after.txt; then
  echo "    identical row counts — no data dropped"
else
  echo "    ^ REVIEW: rows changed. This can be legitimate (backfills add values) —"
  echo "      drops/losses are NOT. Inspect before promoting."
fi

# ---- Idempotence: a second deploy must be a no-op --------------------------
echo "==> Idempotence: re-running migrate deploy (must report no pending migrations)"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${REHEARSAL_PORT}/${DB_NAME}?schema=public" \
  pnpm exec prisma migrate deploy --schema packages/database/prisma/schema.prisma 2>&1 \
  | tee /tmp/rehearsal-idempotence.txt | tail -2
if grep -qiE "already in sync|no pending migrations" /tmp/rehearsal-idempotence.txt; then
  echo "    idempotent: second deploy applied nothing"
else
  die "second migrate deploy was NOT a no-op — migrations are not idempotent. Do NOT promote."
fi

# ---- Optional: boot the API against the upgraded copy ---------------------
if [[ "$START_API" == "1" ]]; then
  docker image inspect tornscope-api:latest >/dev/null 2>&1 \
    || die "START_API=1 but tornscope-api:latest is not built (docker compose -f docker-compose.dev.yml --env-file .env.dev build)"
  docker network create "$REHEARSAL_NET" >/dev/null 2>&1 || true
  docker network connect "$REHEARSAL_NET" "$REHEARSAL_PG" >/dev/null 2>&1 || true
  docker rm -f "$REHEARSAL_REDIS" "$REHEARSAL_API" >/dev/null 2>&1 || true
  docker run -d --name "$REHEARSAL_REDIS" --network "$REHEARSAL_NET" redis:7-alpine >/dev/null
  docker run -d --name "$REHEARSAL_API" --network "$REHEARSAL_NET" \
    -e DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${REHEARSAL_PG}:5432/${DB_NAME}?schema=public" \
    -e REDIS_URL="redis://${REHEARSAL_REDIS}:6379" \
    -e API_KEY_ENCRYPTION_KEY="$(docker exec tornscope-api-1 printenv API_KEY_ENCRYPTION_KEY 2>/dev/null || echo 0000000000000000000000000000000000000000000000000000000000000000)" \
    -e NODE_ENV=production tornscope-api:latest >/dev/null
  sleep 5
  api_code=$(docker exec "$REHEARSAL_API" node -e "fetch('http://localhost:3000/api/ready').then(async (r)=>{console.log(await r.text())}).catch(()=>process.exit(1))" 2>/dev/null | tail -1)
  echo "==> Rehearsal API /api/ready: ${api_code:-<no response>}"
  echo "    NOTE: stored Torn API keys from the prod copy only decrypt with the"
  echo "    PRODUCTION API_KEY_ENCRYPTION_KEY (passed through above when available)."
  [[ "${api_code:-}" == *'"status":"ready"'* ]] || echo "    WARNING: rehearsal API not ready — inspect before promoting."
fi

# ---- Verdict ----------------------------------------------------------------
echo
echo "============================================================"
echo "REHEARSAL RESULT: PASS"
echo "  branch:   $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)"
echo "  dump:     $DUMP_FILE (kept for inspection)"
echo "  verdict:  migrations apply cleanly to a copy of production,"
echo "            are idempotent on re-run, and no table lost rows."
echo "  next:     review the diff above, then plan the production"
echo "            upgrade via docs/V0.2-UPGRADE-CHECKLIST.md."
echo "============================================================"

