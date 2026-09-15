#!/usr/bin/env bash
# Build-identity verification for production deploys (sourced by
# deploy-prod.sh; kept as a separate lib so the safety decision is testable
# without touching Docker or production — see
# apps/api/tests/release-safety.test.ts which executes these functions).
#
# Contract:
#   verify_build_identity <expected-full-sha> <expected-short-sha> <observed-header>
#
# The API stamps every response with x-tornscope-build: $GIT_SHA (the FULL
# commit SHA baked into the image at build time). A deploy may only report
# success when the RUNNING container provably serves the commit that was
# deployed — otherwise a stale cached image would masquerade as a fresh
# deploy. Short-form matches are accepted defensively (some proxies truncate
# the header historically), but a MISSING header or any mismatch is FATAL.
verify_build_identity() {
  local expected_full="$1" expected_short="$2" observed="$3"

  if [[ -z "$observed" ]]; then
    echo "deploy-prod: ERROR: no x-tornscope-build header on ${READY_URL:-the API} —" >&2
    echo "  the running API does not identify its build. Refusing to report success." >&2
    echo "  Remediation: docker compose -f ${COMPOSE_FILE:-docker-compose.unraid.yml} build --no-cache api web worker && redeploy." >&2
    return 1
  fi

  if [[ "$observed" == "$expected_full" || "$observed" == "$expected_short" ]]; then
    return 0
  fi

  {
    echo "deploy-prod: ERROR: build identity mismatch — deployment MUST NOT be called successful."
    echo "  expected (deployed commit): ${expected_full} (short: ${expected_short})"
    echo "  observed (running build):   ${observed}"
    echo "  The running container was built from a different commit — a stale image"
    echo "  is being reused. Remediation: docker compose -f ${COMPOSE_FILE:-docker-compose.unraid.yml} build api web worker"
    echo "  (or deploy with a clean image cache), then re-run this deploy."
  } >&2
  return 1
}
