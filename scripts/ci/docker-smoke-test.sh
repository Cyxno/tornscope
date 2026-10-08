#!/usr/bin/env bash
# CI Docker smoke test: launch the real production compose stack, wait for
# genuine application readiness, assert /api/ready, and ALWAYS tear the
# project back down. Only ever touches its own Compose project — never
# prunes or removes unrelated Docker resources.
#
# v2.6.1 release-safety hardening:
#   - The stack always runs under a DEDICATED Compose project name. Running
#     with the production project name ("tornscope") is a hard failure:
#     `down -v` in cleanup would tear down the live deployment.
#   - Own ephemeral host ports by default (web/api/postgres), so a smoke run
#     coexists with a live production stack that publishes the default ports.
#   - Volumes and networks are project-scoped (Compose derives them from the
#     project name), so `down -v` can only ever remove smoke resources.
#   - Production non-interference evidence: container state, RestartCount and
#     StartedAt of every OTHER Compose project's containers are snapshotted
#     before and after the run and must be identical.
#
# Required environment (CI-only deterministic values):
#   POSTGRES_PASSWORD, API_KEY_ENCRYPTION_KEY  (compose requires both)
# Optional:
#   SMOKE_PROJECT_NAME (default tornscope-smoke; MUST NOT be a production name)
#   SMOKE_WEB_HOST_PORT / SMOKE_API_HOST_PORT / SMOKE_POSTGRES_HOST_PORT
#     (default: three free ephemeral ports)
#   SMOKE_TIMEOUT    (default 300 seconds, bounded)
set -uo pipefail

PROJECT_NAME="${SMOKE_PROJECT_NAME:-tornscope-smoke}"
TIMEOUT_SECONDS="${SMOKE_TIMEOUT:-300}"
FAILED=0

dc() { docker compose -p "$PROJECT_NAME" "$@"; }

# ---- Production-non-interference guard (fail closed, BEFORE the trap) -------
# Production deploys as Compose project "tornscope" (docker-compose.unraid.yml)
# and dev as "tornscope-dev" (docker-compose.dev.yml). If the smoke project
# name collides with any of them, `down -v` would target the live stack. This
# guard must run before the EXIT trap exists: the trap invokes `compose down`,
# which is only safe once the project name has been proven non-production.
case "$PROJECT_NAME" in
  tornscope|tornscope-dev|tornscope-prod)
    echo "::error::SMOKE_PROJECT_NAME '$PROJECT_NAME' collides with a production/dev Compose project — refusing to run"
    exit 1
    ;;
esac
if [[ ! "$PROJECT_NAME" =~ ^tornscope-(smoke|ci) ]]; then
  echo "::error::SMOKE_PROJECT_NAME '$PROJECT_NAME' does not match ^tornscope-(smoke|ci) — smoke runs must use an unmistakably non-production project name"
  exit 1
fi

cleanup() {
  echo
  echo "::group::Smoke-test diagnostics (compose ps + logs)"
  dc ps -a || true
  dc logs --tail 120 postgres redis migrate api worker web 2>&1 | tail -n 200 || true
  echo "::endgroup::"
  # Tear down ONLY this Compose project: its containers + volumes + networks
  # are all project-scoped, so production resources are unreachable here.
  dc down -v --remove-orphans || true
}
trap cleanup EXIT

fail() { echo "::error::$1"; FAILED=1; }

echo "==> Compose project: $PROJECT_NAME (production guard OK)"

free_port() { node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
WEB_HOST_PORT="${SMOKE_WEB_HOST_PORT:-$(free_port)}"
API_HOST_PORT="${SMOKE_API_HOST_PORT:-$(free_port)}"
POSTGRES_HOST_PORT="${SMOKE_POSTGRES_HOST_PORT:-$(free_port)}"
WEB_URL="http://127.0.0.1:${WEB_HOST_PORT}"
export WEB_HOST_PORT API_HOST_PORT POSTGRES_HOST_PORT
echo "==> Host ports: web=${WEB_HOST_PORT} api=${API_HOST_PORT} postgres=${POSTGRES_HOST_PORT}"

# ---- Production snapshot (before) -------------------------------------------
# Every container that belongs to a Compose project OTHER than this smoke run.
snapshot_prod() {
  local id proj
  for id in $(docker ps -a --format '{{.ID}}'); do
    proj=$(docker inspect -f '{{ if .Config.Labels }}{{ index .Config.Labels "com.docker.compose.project" }}{{ else }}-{{ end }}' "$id" 2>/dev/null) || continue
    [[ "$proj" == "$PROJECT_NAME" ]] && continue
    docker inspect -f "${proj}|{{ slice .Name 1 }}|{{ .State.Status }}|{{ .RestartCount }}|{{ .State.StartedAt }}" "$id" 2>/dev/null || true
  done | sort
}
BEFORE=$(snapshot_prod)

echo "==> Starting smoke-test stack"
# Source-build path (build override present): compose reuses an existing
# image verbatim, so a locally cached image would carry a stale GIT_SHA and
# trip the build-identity assertion below. Rebuild explicitly.
if dc config --format json 2>/dev/null | grep -q '"build"'; then
  echo "==> Building images first (source-build path; GIT_SHA=${GIT_SHA:-unset})"
  dc build || { fail "docker compose build failed"; exit 1; }
fi
dc up -d || { fail "docker compose up failed"; exit 1; }

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
running=$(dc ps --status running --services 2>/dev/null || echo "")
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

# ---- Production non-interference evidence -----------------------------------
AFTER=$(snapshot_prod)
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "::group::Production non-interference DIFF"
  diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") || true
  echo "::endgroup::"
  fail "External containers changed during the smoke run (state/RestartCount/StartedAt drift) — production non-interference violated"
  exit 1
fi
echo "==> Production non-interference verified: $(grep -c . <<<"$BEFORE") external container(s) unchanged (status/RestartCount/StartedAt)"

echo "==> Smoke test PASSED"
if [[ $FAILED -ne 0 ]]; then exit 1; fi
