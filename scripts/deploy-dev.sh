#!/usr/bin/env bash
# Deploy the DEVELOPMENT / STAGING TornScope stack (branch: develop, compose
# project: tornscope-dev). Run this from the DEDICATED develop checkout
# (e.g. /workspace/tornscope-dev) — never from the production checkout.
#
# Usage:
#   scripts/deploy-dev.sh              # build + restart dev, verify ready
#   scripts/deploy-dev.sh --no-build   # restart with the existing images
#
# Overrides:
#   TORNSCOPE_ALLOW_DIRTY=1  deploy with a dirty working tree (local experiments)
#   READY_URL                (default http://127.0.0.1:3101/api/ready)
#   WEB_URL                  (default http://127.0.0.1:5273/)
#
# Isolation contract (see docs/ENVIRONMENTS.md): this script only ever
# touches the tornscope-dev compose project — separate containers, postgres
# volume, redis, ports (5273/3101) and database (tornscope_dev).
set -euo pipefail

cd "$(dirname "$0")/.."

READY_URL="${READY_URL:-http://127.0.0.1:3101/api/ready}"
WEB_URL="${WEB_URL:-http://127.0.0.1:5273/}"
NO_BUILD=0
[[ "${1:-}" == "--no-build" ]] && NO_BUILD=1

die() { echo "deploy-dev: ERROR: $*" >&2; exit 1; }

# ---- Safety guards ------------------------------------------------------
branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$branch" == "develop" ]] || die "must be run from 'develop' (currently on '$branch'). Run this from the dedicated dev checkout, e.g. /workspace/tornscope-dev."

if [[ -n "$(git status --porcelain)" && "${TORNSCOPE_ALLOW_DIRTY:-0}" != "1" ]]; then
  die "working tree is dirty. Commit, stash, or set TORNSCOPE_ALLOW_DIRTY=1 to deploy local experiments intentionally."
fi

[[ -f .env.dev ]] || die ".env.dev not found — create it from .env.dev.example (cp .env.dev.example .env.dev, then add fresh dev secrets)."

ENV_FILE_ABS=$(readlink -f .env.dev)

# Cross-environment contamination guards: dev env must never mention the
# production domain, and the dev database name must be clearly dev-scoped.
if grep -q "tornscope.cyxno.eu" "$ENV_FILE_ABS"; then
  die ".env.dev mentions the PRODUCTION domain (tornscope.cyxno.eu) — fix the dev env file."
fi
dev_db=$(grep -E '^POSTGRES_DB=' "$ENV_FILE_ABS" | head -1 | cut -d= -f2-)
[[ "$dev_db" == *_dev ]] || die "POSTGRES_DB ('$dev_db') does not end in _dev — dev must use a clearly separate database name."

if ! grep -Eq '^PUBLIC_ENV_LABEL=.+' "$ENV_FILE_ABS"; then
  echo "    WARNING: PUBLIC_ENV_LABEL is empty — the dev UI will show 'Beta' instead of a dev marker."
fi

echo "==> Dev/staging deploy from develop @ $(git rev-parse --short HEAD)"
echo "    compose: docker-compose.dev.yml (project: tornscope-dev)"

export GIT_SHA GIT_SHA_SHORT
GIT_SHA=$(git rev-parse HEAD)
GIT_SHA_SHORT=$(git rev-parse --short HEAD)

# ---- Build & restart (only this compose project) -------------------------
if [[ "$NO_BUILD" -eq 0 ]]; then
  echo "==> Building dev images"
  docker compose -f docker-compose.dev.yml --env-file .env.dev build
fi

echo "==> Restarting dev services (migrations run via the migrate one-shot)"
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d

# ---- Verify --------------------------------------------------------------
echo "==> Waiting for ${READY_URL}"
code=000; body=""
for _ in $(seq 1 60); do
  code=$(curl -s -o /tmp/ts-dev-ready.json -w "%{http_code}" -m 5 "$READY_URL" 2>/dev/null || echo 000)
  body=$(cat /tmp/ts-dev-ready.json 2>/dev/null || echo "")
  [[ "$code" == "200" && "$body" == *'"status":"ready"'* ]] && break
  sleep 5
done
[[ "$code" == "200" && "$body" == *'"status":"ready"'* ]] || die "dev /api/ready not healthy (http=$code body=$body). Check: docker compose -f docker-compose.dev.yml --env-file .env.dev logs"
echo "    /api/ready -> $body"

webcode=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$WEB_URL" || echo 000)
[[ "$webcode" == "200" ]] || die "dev web $WEB_URL returned $webcode"
echo "    web -> 200"

echo "==> Dev deploy OK — build ${GIT_SHA_SHORT} on https://torn.familievalk.com (dev DB: ${dev_db})"
