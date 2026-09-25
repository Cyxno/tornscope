#!/usr/bin/env bash
# Postgres storage preflight for the Unraid TornScope deployment.
#
# Background: on 2026-09-25 a deploy invoked the BASE compose file instead of
# docker-compose.unraid.yml. The base file models postgres storage as a named
# volume, so compose recreated postgres with an EMPTY volume while the real
# data lived on the Unraid bind mount /mnt/user/appdata/tornscope/postgres.
# This check exists so that can never happen silently again.
#
# It hard-aborts BEFORE any container is built, created or restarted when:
#   1. the resolved compose config does NOT mount postgres from
#      /mnt/user/appdata/tornscope/postgres (bind), or
#   2. a RUNNING tornscope postgres container does NOT use that bind mount, or
#   3. the bind path has no data but a tornscope postgres named volume DOES
#      (data would be stranded on the wrong storage).
#
# Usage: scripts/preflight-postgres-path.sh [COMPOSE_FILE]
#   COMPOSE_FILE defaults to docker-compose.unraid.yml.
#   TEST_CONTAINER_NAME overrides the running-container name (for tests only).
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="${1:-${COMPOSE_FILE:-docker-compose.unraid.yml}}"
EXPECTED_SOURCE="${TEST_BIND_SOURCE:-/mnt/user/appdata/tornscope/postgres}"
DATA_VOLUME="${TEST_DATA_VOLUME:-tornscope_postgres-data}"
CONTAINER_NAME="${TEST_CONTAINER_NAME:-tornscope-postgres-1}"
POSTGRES_SERVICE="${TEST_POSTGRES_SERVICE:-postgres}"

die() { echo "preflight-postgres: HARD ABORT: $*" >&2; exit 1; }
info() { echo "preflight-postgres: $*"; }

[[ -f "$COMPOSE_FILE" ]] || die "compose file '$COMPOSE_FILE' not found."

# ---- 1. Resolved compose config must bind-mount the Unraid path ----------
resolved=$(docker compose -f "$COMPOSE_FILE" config --format json 2>/dev/null) \
  || die "docker compose config failed for '$COMPOSE_FILE'."
mounts=$(echo "$resolved" | node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const cfg = JSON.parse(raw);
    const svc = (cfg.services || {})[process.argv[1]] || {};
    const vols = svc.volumes || [];
    const data = vols
      .filter((v) => v.target === "/var/lib/postgresql/data")
      .map((v) => `${v.type}:${v.source ?? "(anon)"}`);
    console.log(data.join(","));
  });
' "$POSTGRES_SERVICE")
[[ "$mounts" == "bind:$EXPECTED_SOURCE" ]] \
  || die "compose '$COMPOSE_FILE' mounts postgres as [$mounts] instead of bind:$EXPECTED_SOURCE. This deploy would point the database at the WRONG storage. Use docker-compose.unraid.yml."
info "compose config OK: postgres bind mount -> $EXPECTED_SOURCE"

# ---- 2. A running postgres container must already use that bind mount -----
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  running=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}:{{.Source}}{{end}}{{end}}')
  [[ "$running" == "bind:$EXPECTED_SOURCE" ]] \
    || die "running container '$CONTAINER_NAME' mounts postgres as [$running], not bind:$EXPECTED_SOURCE. Recreate it from $COMPOSE_FILE (with the data path intact) BEFORE deploying."
  info "running container OK: $CONTAINER_NAME uses the bind mount"
else
  info "no running container named '$CONTAINER_NAME' (fresh host or stopped stack) — skipping runtime check"
fi

# ---- 3. Data must live on the bind path, not in a named volume ------------
if [[ ! -f "$EXPECTED_SOURCE/PG_VERSION" ]]; then
  if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1 \
     && docker run --rm -v "$DATA_VOLUME":/d:ro alpine test -f /d/PG_VERSION 2>/dev/null; then
    die "$EXPECTED_SOURCE contains no database, but named volume '$DATA_VOLUME' DOES. The real data is on the wrong storage — recover it first (docs/production-checklist.md) instead of deploying."
  fi
  die "$EXPECTED_SOURCE/PG_VERSION not found — the bind path holds no initialized database. Refusing to start against empty storage."
fi
info "data OK: $EXPECTED_SOURCE holds an initialized database"

echo "preflight-postgres: PASS — postgres storage is the Unraid bind mount; deploy may proceed."
