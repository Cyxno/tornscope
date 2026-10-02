#!/usr/bin/env bash
# Regression tests for the postgres storage-path preflight policy.
#
#   bash scripts/tests/test-preflight-postgres-path.sh
#
# Pins the 2026-10-02 storage-hardening contract:
#   - direct pool bind (/mnt/cache/appdata/...)  -> PASS
#   - shfs bind (/mnt/user/appdata/...)          -> FAIL
#   - running container on the shfs bind         -> FAIL
#   - missing/empty canonical data dir           -> FAIL
# The preflight must NEVER silently "correct" postgres back onto /mnt/user.
# Runs on any host with docker: the PASS-case data dir reuses the live
# production data when present, otherwise a synthesized one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PREFLIGHT="scripts/preflight-postgres-path.sh"
TMP="$(mktemp -d)"
trap 'docker rm -f pf-test-shfs >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

make_fixture() {
  local source_path="$1" file="$2"
  cat > "$file" <<EOF
services:
  postgres:
    image: postgres:16-alpine
    volumes:
      - ${source_path}:/var/lib/postgresql/data
EOF
}

expect_pass() {
  local desc="$1"; shift
  if bash "$ROOT/$PREFLIGHT" "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc (expected PASS)"; fi
}

expect_fail() {
  local desc="$1"; shift
  local out
  if out=$(bash "$ROOT/$PREFLIGHT" "$@" 2>&1); then
    fail "$desc (expected FAIL, got PASS)"
  elif ! grep -q "HARD ABORT" <<<"$out"; then
    fail "$desc (failed without HARD ABORT)"
  else
    pass "$desc"
  fi
}

# PASS-case data directory: reuse the LIVE production data when present
# (the real host), otherwise synthesize a minimal initialized one (CI).
LIVE_DATA="/mnt/cache/appdata/tornscope/postgres"
if [[ -f "$LIVE_DATA/PG_VERSION" ]]; then
  PASS_DATA="$LIVE_DATA"
else
  PASS_DATA="$TMP/pass-data"
  # A minimal but REALISTIC postgres data layout (the preflight's
  # population guard requires more than the bare minimum).
  mkdir -p "$PASS_DATA/base" "$PASS_DATA/global" "$PASS_DATA/pg_wal" "$PASS_DATA/pg_tblspc"
  echo 16 > "$PASS_DATA/PG_VERSION"
fi
make_fixture "$PASS_DATA" "$TMP/compose-cache.yaml"
make_fixture "/mnt/user/appdata/tornscope/postgres" "$TMP/compose-shfs.yaml"

# 1. Direct pool bind in compose + no running container clash -> PASS.
TEST_BIND_SOURCE="$PASS_DATA" TEST_CONTAINER_NAME="pf-test-nonexistent" \
  expect_pass "compose with direct pool bind passes" "$TMP/compose-cache.yaml"

# 2. shfs bind in compose -> FAIL (the core policy).
TEST_CONTAINER_NAME="pf-test-nonexistent" \
  expect_fail "compose with /mnt/user shfs bind fails" "$TMP/compose-shfs.yaml"

# 3. Compose + expected agree, but the RUNNING container mounts something
#    else -> FAIL (exactly how 2.2.0 silently moved postgres back to
#    /mnt/user: expected path and compose said one thing, the live container
#    another).
mkdir -p "$TMP/expected-data" "$TMP/container-data"
echo 16 > "$TMP/expected-data/PG_VERSION"
echo 16 > "$TMP/container-data/PG_VERSION"
make_fixture "$TMP/expected-data" "$TMP/compose-expected.yaml"
docker rm -f pf-test-shfs >/dev/null 2>&1 || true
docker run -d --name pf-test-shfs -v "$TMP/container-data":/var/lib/postgresql/data alpine sleep 60 >/dev/null
TEST_BIND_SOURCE="$TMP/expected-data" TEST_CONTAINER_NAME="pf-test-shfs" \
  expect_fail "running container on a divergent bind fails" "$TMP/compose-expected.yaml"
docker rm -f pf-test-shfs >/dev/null 2>&1 || true

# 4. Empty canonical data directory -> FAIL (never init over a path error).
mkdir -p "$TMP/empty-data"
make_fixture "$TMP/empty-data" "$TMP/compose-empty.yaml"
TEST_BIND_SOURCE="$TMP/empty-data" TEST_CONTAINER_NAME="pf-test-nonexistent" \
  expect_fail "empty canonical data dir fails" "$TMP/compose-empty.yaml"

# 5. Missing canonical data directory -> FAIL.
make_fixture "$TMP/missing-data" "$TMP/compose-missing.yaml"
TEST_BIND_SOURCE="$TMP/does-not-exist" TEST_CONTAINER_NAME="pf-test-nonexistent" \
  expect_fail "missing canonical data dir fails" "$TMP/compose-missing.yaml"

# 6. Never-autocorrect invariant: the script only aborts, never rewrites.
if grep -qiE "correct(ing)? (the|it)|switch(ing)? (back )?to /mnt/user" "$ROOT/$PREFLIGHT"; then
  fail "preflight suggests auto-correcting the bind"
else
  pass "preflight only aborts, never auto-corrects"
fi

echo "preflight-postgres-path: ALL REGRESSION TESTS PASSED"
