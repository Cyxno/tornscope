#!/usr/bin/env bash
# Deploy the PRODUCTION TornScope stack (branch: main, compose project:
# tornscope). Safety-first: refuses to run from the wrong branch, a dirty
# tree, or a checkout that is not in sync with origin/main. Never touches the
# dev stack (tornscope-dev) or its files.
#
# Usage:
#   scripts/deploy-prod.sh              # build + restart prod, verify ready
#   scripts/deploy-prod.sh --no-build   # restart with the existing images
#
# Overrides (rarely needed):
#   COMPOSE_FILE  (default docker-compose.unraid.yml — this server's prod file)
#   READY_URL     (default http://127.0.0.1:3100/api/ready)
#   WEB_URL       (default http://127.0.0.1:5173/)
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.unraid.yml}"
READY_URL="${READY_URL:-http://127.0.0.1:3100/api/ready}"
WEB_URL="${WEB_URL:-http://127.0.0.1:5173/}"
NO_BUILD=0
[[ "${1:-}" == "--no-build" ]] && NO_BUILD=1

die() { echo "deploy-prod: ERROR: $*" >&2; exit 1; }

# ---- Safety guards ------------------------------------------------------
branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$branch" == "main" ]] || die "must be run from 'main' (currently on '$branch'). Production deploys only ever happen from main."

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty — commit or stash first. Production always deploys a clean, committed state."

git fetch origin main --quiet
local_sha=$(git rev-parse HEAD)
origin_sha=$(git rev-parse origin/main)
[[ "$local_sha" == "$origin_sha" ]] || die "local main ($local_sha) != origin/main ($origin_sha) — pull/push first so prod always runs a pushed commit."

[[ -f .env ]] || die ".env not found — production environment file missing."

# Cross-environment contamination guard: prod env must never mention the dev domain.
if grep -q "familievalk.com" .env; then
  die ".env mentions the DEV domain (familievalk.com) — production env is contaminated."
fi

echo "==> Production deploy from main @ $(git rev-parse --short HEAD)"
echo "    compose: $COMPOSE_FILE (project: tornscope)"

export GIT_SHA GIT_SHA_SHORT
GIT_SHA=$(git rev-parse HEAD)
GIT_SHA_SHORT=$(git rev-parse --short HEAD)

# ---- Build & restart (only this compose project) -------------------------
if [[ "$NO_BUILD" -eq 0 ]]; then
  echo "==> Building production images"
  docker compose -f "$COMPOSE_FILE" build
fi

echo "==> Restarting production services (migrations run via the migrate one-shot)"
docker compose -f "$COMPOSE_FILE" up -d

# ---- Verify --------------------------------------------------------------
echo "==> Waiting for ${READY_URL}"
code=000; body=""
for _ in $(seq 1 60); do
  code=$(curl -s -o /tmp/ts-prod-ready.json -w "%{http_code}" -m 5 "$READY_URL" 2>/dev/null || echo 000)
  body=$(cat /tmp/ts-prod-ready.json 2>/dev/null || echo "")
  [[ "$code" == "200" && "$body" == *'"status":"ready"'* ]] && break
  sleep 5
done
[[ "$code" == "200" && "$body" == *'"status":"ready"'* ]] || die "production /api/ready not healthy (http=$code body=$body). Check: docker compose -f $COMPOSE_FILE logs"
echo "    /api/ready -> $body"

webcode=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$WEB_URL" || echo 000)
[[ "$webcode" == "200" ]] || die "production web $WEB_URL returned $webcode"
echo "    web -> 200"

api_build=$(curl -s -m 5 -D - -o /dev/null "$READY_URL" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="x-tornscope-build:"{print $2}')
# The running build MUST be the deployed commit — a stale image can never
# count as a successful deploy (V1.0 hardening: this used to warn and
# continue, and even compared the full-SHA header to the short SHA).
source "$(dirname "$0")/lib/build-identity.sh"
if ! verify_build_identity "$GIT_SHA" "$GIT_SHA_SHORT" "$api_build"; then
  echo "deploy-prod: deploy FAILED — running build does not match the deployed commit." >&2
  exit 1
fi
echo "==> Production deploy OK — running build: ${api_build} (expected ${GIT_SHA_SHORT})"
