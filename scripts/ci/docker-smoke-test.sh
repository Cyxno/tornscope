#!/usr/bin/env bash
# CI Docker smoke test: launch the real production compose stack, wait for
# genuine application readiness, assert /api/ready, and ALWAYS tear the
# project back down. Only ever touches its own Compose project — never
# prunes or removes unrelated Docker resources.
#
# Required environment (CI-only deterministic values):
#   POSTGRES_PASSWORD, API_KEY_ENCRYPTION_KEY  (compose requires both)
# Optional:
#   SMOKE_WEB_URL    (default http://127.0.0.1:5173)
#   SMOKE_TIMEOUT    (default 300 seconds, bounded)
set -uo pipefail

WEB_URL="${SMOKE_WEB_URL:-http://127.0.0.1:5173}"
TIMEOUT_SECONDS="${SMOKE_TIMEOUT:-300}"
FAILED=0

cleanup() {
  echo
  echo "::group::Smoke-test diagnostics (compose ps + logs)"
  docker compose ps -a || true
  docker compose logs --tail 120 postgres redis migrate api worker web 2>&1 | tail -n 200 || true
  echo "::endgroup::"
  # Tear down ONLY this Compose project: its containers + volumes.
  docker compose down -v --remove-orphans || true
}
trap cleanup EXIT

fail() { echo "::error::$1"; FAILED=1; }

echo "==> Starting smoke-test stack"
docker compose up -d || { fail "docker compose up failed"; exit 1; }

echo "==> Waiting up to ${TIMEOUT_SECONDS}s for ${WEB_URL}/api/ready ..."
deadline=$((SECONDS + TIMEOUT_SECONDS))
code=000
body=""
while (( SECONDS < deadline )); do
  code=$(curl -s -o /tmp/smoke-body.json -w "%{http_code}" -m 5 "$WEB_URL/api/ready" 2>/dev/null || echo 000)
  body=$(cat /tmp/smoke-body.json 2>/dev/null || echo "")
  if [[ "$code" == "200" && "$body" == *'"status":"ready"'* ]]; then
    echo "    /api/ready -> 200 $body"
    break
  fi
  echo "    t=${SECONDS}s http=$code body=${body:-(no response)} — retrying"
  sleep 5
done

if [[ "$code" != "200" || "$body" != *'"status":"ready"'* ]]; then
  fail "Readiness not reached within ${TIMEOUT_SECONDS}s (last: http=$code body=${body:-(none)})"
  exit 1
fi

# Web page itself must render through the same public path (web → api internal
# networking is exercised by /api/ready already; this is the browser entry).
page=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$WEB_URL/" || echo 000)
if [[ "$page" != "200" ]]; then
  fail "Web page did not return 200 (got $page)"
  exit 1
fi
echo "==> Web page returned 200"

# Build-identity assertion (V1.0 hardening): the READY api container must
# report exactly the GIT_SHA the images were built with — catches stale
# cached images / miswired GIT_SHA injection masquerading as a green build.
# Expected value: SMOKE_EXPECT_SHA, else $GIT_SHA, else "dev" (local builds
# without an injected SHA legitimately stamp "dev").
expected_sha="${SMOKE_EXPECT_SHA:-${GIT_SHA:-dev}}"
build_header=$(curl -s -m 5 -D - -o /dev/null "$WEB_URL/api/ready" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="x-tornscope-build:"{print $2}')
if [[ -z "$build_header" ]]; then
  fail "API did not return an x-tornscope-build header — build identity unknown"
  exit 1
fi
if [[ "$build_header" != "$expected_sha" ]]; then
  fail "Build identity drift: x-tornscope-build ($build_header) != expected ($expected_sha) — stale image or broken GIT_SHA wiring"
  exit 1
fi
echo "==> Build identity verified: ${build_header}"

# Stack composition: exactly the five production services should be up.
running=$(docker compose ps --status running --services 2>/dev/null || echo "")
missing=""
for svc in postgres redis api worker web; do
  if ! grep -qx "$svc" <<<"$running"; then
    missing="$missing $svc"
  fi
done
if [[ -n "$missing" ]]; then
  fail "Services not running:$missing"
  exit 1
fi
echo "==> All five services (postgres redis api worker web) running"

echo "==> Smoke test PASSED"
