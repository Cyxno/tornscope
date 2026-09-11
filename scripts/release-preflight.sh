#!/usr/bin/env bash
# TornScope release preflight (roadmap #9). Deterministic PASS/FAIL gate to
# run BEFORE declaring a release candidate or promoting develop → main.
#
# Usage:
#   scripts/release-preflight.sh            # full preflight on current tree
#   scripts/release-preflight.sh --quick    # skip install/build-heavy steps
#
# Exits 0 with "PREFLIGHT PASS" or 1 with "PREFLIGHT FAIL" + reasons.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILURES=()
PASS=()
QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

ok()   { PASS+=("$1"); }
fail() { FAILURES+=("$1"); }

section() { printf '\n== %s ==\n' "$1"; }

# ---- 1. Tree + branch ------------------------------------------------------
section "git state"
branch=$(git rev-parse --abbrev-ref HEAD)
[[ "$branch" == "develop" || "$branch" == "main" ]] && ok "branch is $branch" || fail "branch is '$branch' (expected develop or main)"
[[ -z "$(git status --porcelain)" ]] && ok "working tree clean" || fail "working tree dirty — commit or stash"
git fetch origin --quiet 2>/dev/null
local_sha=$(git rev-parse HEAD)
origin_sha=$(git rev-parse "origin/$branch" 2>/dev/null || echo "?")
[[ "$local_sha" == "$origin_sha" ]] && ok "local == origin/$branch ($(git rev-parse --short HEAD))" || fail "local != origin/$branch"

# ---- 2. Version coherence ---------------------------------------------------
section "version coherence"
root_version=$(node -p "require('./package.json').version")
mismatch=$(node -e "
  const fs=require('fs');
  const bad=[];
  for (const p of ['apps/api','apps/web','apps/worker','packages/shared','packages/analytics','packages/database','packages/torn-api','packages/ui']) {
    if (require('./'+p+'/package.json').version !== '$root_version') bad.push(p);
  }
  console.log(bad.join(' '));
")
[[ -z "$mismatch" ]] && ok "all workspace versions == $root_version" || fail "version mismatch in: $mismatch"

# ---- 3. Docs + release artifacts -------------------------------------------
section "release artifacts"
for doc in docs/V0.2-RELEASE-CHECKLIST.md docs/DATABASE-MIGRATIONS.md docs/HOSTED-SECURITY.md docs/HOSTED-DEPLOYMENT.md docs/RC-QA.md; do
  [[ -f "$doc" ]] && ok "$doc present" || fail "$doc missing"
done

# ---- 4. Migrations committed + inventoried ----------------------------------
section "migrations"
untracked_migrations=$(git ls-files --others --exclude-standard packages/database/prisma/migrations | head -5)
[[ -z "$untracked_migrations" ]] && ok "no untracked migrations" || fail "untracked migrations: $untracked_migrations"
prod_migration="20260909120000_sync_state_last_heartbeat_at"
for m in packages/database/prisma/migrations/*/; do
  name=$(basename "$m")
  if [[ "$name" > "$prod_migration" ]]; then
    grep -q "$name" docs/DATABASE-MIGRATIONS.md && ok "migration $name inventoried" || fail "migration $name NOT in docs/DATABASE-MIGRATIONS.md"
  fi
done

# ---- 5. Dev-domain / marker leakage ------------------------------------------
section "leak checks"
if grep -rn "familievalk" --include="*.ts" --include="*.svelte" --include="*.yml" apps packages docker docker-compose*.yml 2>/dev/null | grep -v "\.example" | grep -q .; then
  fail "hardcoded dev domain found in source/compose"
else
  ok "no hardcoded dev domain"
fi
if grep -rn "TODO.*(blocker\|FIXME.*release)" --include="*.ts" --include="*.svelte" apps packages 2>/dev/null | grep -q .; then
  fail "release-blocker TODO/FIXME present"
else
  ok "no release-blocker TODO/FIXME"
fi

# ---- 6. Compose variants valid ----------------------------------------------
section "compose"
if POSTGRES_PASSWORD=preflight API_KEY_ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) docker compose -f docker-compose.yml config --quiet >/dev/null 2>&1; then
  ok "docker-compose.yml valid"
else
  fail "docker-compose.yml invalid"
fi
if [[ -f .env.dev ]] && docker compose --env-file .env.dev -f docker-compose.dev.yml config --quiet >/dev/null 2>&1; then
  ok "docker-compose.dev.yml valid"
else
  [[ -f .env.dev ]] && fail "docker-compose.dev.yml invalid" || ok "docker-compose.dev.yml skipped (no .env.dev)"
fi
if [[ -f .env.dev ]] && docker compose --env-file .env.dev -f docker-compose.unraid.yml config --quiet >/dev/null 2>&1; then
  ok "docker-compose.unraid.yml valid"
else
  [[ -f .env.dev ]] && fail "docker-compose.unraid.yml invalid" || ok "docker-compose.unraid.yml skipped (no .env.dev)"
fi

# ---- 7. Full gates ------------------------------------------------------------
section "gates"
pnpm lint >/dev/null 2>&1 && ok "lint" || fail "lint failed"
pnpm typecheck >/dev/null 2>&1 && ok "typecheck" || fail "typecheck failed"
pnpm --filter @tornscope/web exec svelte-check --tsconfig ./tsconfig.json >/dev/null 2>&1 && ok "svelte-check" || fail "svelte-check failed"

if [[ $QUICK -eq 0 ]]; then
  if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
    pnpm test >/dev/null 2>&1 && ok "full test suite" || fail "test suite failed"
  else
    fail "TEST_DATABASE_URL not set — DB-backed tests cannot run (set it and re-run)"
  fi
  pnpm build >/dev/null 2>&1 && ok "build" || fail "build failed"
else
  echo "(--quick: skipping test suite + build)"
fi

# ---- Verdict ------------------------------------------------------------------
printf '\n== PREFLIGHT VERDICT ==\n'
for p in "${PASS[@]}"; do printf '  PASS  %s\n' "$p"; done
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  for f in "${FAILURES[@]}"; do printf '  FAIL  %s\n' "$f"; done
  printf '\nPREFLIGHT FAIL (%d failure(s))\n' "${#FAILURES[@]}"
  exit 1
fi
printf '\nPREFLIGHT PASS\n'
