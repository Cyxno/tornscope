#!/usr/bin/env bash
# Postgres storage preflight for the Unraid TornScope deployment.
#
# POLICY (2026-10-02 storage hardening): PostgreSQL is latency-sensitive and
# MUST run on the DIRECT pool path — /mnt/cache/appdata/tornscope/postgres —
# never through the Unraid shfs/FUSE layer (/mnt/user/...). During the
# 2026-10-02 shfs incident /mnt/user wedged while /mnt/cache stayed healthy,
# wedging every postgres backend in D-state. The appdata share is
# cache-only (shareUseCache="only", pool "cache"), so /mnt/user/appdata is
# PURELY the shfs view of the same files: the direct path is not a copy, it
# is the physical location.
#
# This check hard-aborts BEFORE any container is built, created or
# restarted when:
#   1. the resolved compose config does NOT mount postgres from the direct
#      pool path (bind),
#   2. a RUNNING tornscope postgres container does NOT use that bind (this
#      is what silently moved production back to /mnt/user after the
#      incident), or
#   3. the bind path fails the data-safety guards: no PG_VERSION (empty or
#      wrong storage), or data stranded in a tornscope named volume.
#
# Usage: scripts/preflight-postgres-path.sh [COMPOSE_FILE]
#   COMPOSE_FILE defaults to ${COMPOSE_FILE:-docker-compose.unraid.yml}.
#   TEST_* env overrides exist for the regression test only.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="${1:-${COMPOSE_FILE:-docker-compose.unraid.yml}}"
EXPECTED_SOURCE="${TEST_BIND_SOURCE:-/mnt/cache/appdata/tornscope/postgres}"
DATA_VOLUME="${TEST_DATA_VOLUME:-tornscope_postgres-data}"
CONTAINER_NAME="${TEST_CONTAINER_NAME:-tornscope-postgres-1}"
POSTGRES_SERVICE="${TEST_POSTGRES_SERVICE:-postgres}"

die() { echo "preflight-postgres: HARD ABORT: $*" >&2; exit 1; }
info() { echo "preflight-postgres: $*"; }

[[ -f "$COMPOSE_FILE" ]] || die "compose file '$COMPOSE_FILE' not found."

# ---- 1. Resolved compose config must bind-mount the DIRECT pool path -----
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
  || die "compose '$COMPOSE_FILE' mounts postgres as [$mounts] instead of bind:$EXPECTED_SOURCE. PostgreSQL MUST run on the direct pool path, never through shfs (/mnt/user). See docs/ENVIRONMENTS.md — PostgreSQL storage policy."
info "compose config OK: postgres bind mount -> $EXPECTED_SOURCE (direct pool path, shfs bypassed)"

# ---- 2. A running postgres container must already use that bind mount -----
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  running=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}:{{.Source}}{{end}}{{end}}')
  [[ "$running" == "bind:$EXPECTED_SOURCE" ]] \
    || die "running container '$CONTAINER_NAME' mounts postgres as [$running], not bind:$EXPECTED_SOURCE. Recreate it from $COMPOSE_FILE (data path intact — the pool path holds the SAME physical dataset) BEFORE deploying."
  info "running container OK: $CONTAINER_NAME uses the direct pool bind"
else
  info "no running container named '$CONTAINER_NAME' (fresh host or stopped stack) — skipping runtime check"
fi

# ---- 3. Data-safety guards on the canonical path --------------------------
if [[ ! -d "$EXPECTED_SOURCE" ]]; then
  die "$EXPECTED_SOURCE does not exist — refusing to let postgres initialize an empty database over a path error. Check the pool name and the appdata share before deploying."
fi
if [[ ! -f "$EXPECTED_SOURCE/PG_VERSION" ]]; then
  if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1 \
     && docker run --rm -v "$DATA_VOLUME":/d:ro alpine test -f /d/PG_VERSION 2>/dev/null; then
    die "$EXPECTED_SOURCE contains no database, but named volume '$DATA_VOLUME' DOES. The real data is on the wrong storage — recover it first (docs/production-checklist.md) instead of deploying."
  fi
  die "$EXPECTED_SOURCE/PG_VERSION not found — the bind path holds no initialized database. Refusing to start against empty storage."
fi
entries=$(ls -A "$EXPECTED_SOURCE" | wc -l)
[[ "$entries" -gt 3 ]] || die "$EXPECTED_SOURCE looks unexpectedly empty ($entries entries) — not a populated data directory. Aborting."
info "data OK: $EXPECTED_SOURCE holds an initialized database"

echo "preflight-postgres: PASS — postgres storage is the direct pool bind (shfs bypassed); deploy may proceed."
