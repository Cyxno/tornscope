#!/usr/bin/env bash
# TornScope release preflight. Deterministic PASS/FAIL gate to run BEFORE
# declaring a release candidate or promoting develop → main.
#
# Usage:
#   scripts/release-preflight.sh            # full preflight on current tree
#   scripts/release-preflight.sh --quick    # skip install/build-heavy steps
#
# Exits 0 with "PREFLIGHT PASS" (full mode — release-grade) or
# "PREFLIGHT QUICK PASS — NOT RELEASE APPROVAL" (--quick), and 1 with
# "PREFLIGHT FAIL" + reasons otherwise.
#
# V1.0 hardening: validates the CURRENT tree against generic release
# artifacts (docs/RELEASE-CHECKLIST.md) — never a historical version's
# files. The production migration baseline is read from
# docs/DATABASE-MIGRATIONS.md (the living inventory), never hardcoded here.
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
[[ "$local_sha" == "$origin_sha" ]] && ok "local == origin/$branch ($(git rev-parse --short HEAD))" || fail "local != origin/$branch — push before releasing (a release SHA must exist on the remote)"

# ---- 2. Version + toolchain coherence ---------------------------------------
section "version & toolchain coherence"
if node scripts/version-check.mjs >/dev/null 2>&1; then
  ok "versions + pnpm pin coherent ($(node -p "require('./package.json').version"))"
else
  node scripts/version-check.mjs 2>&1 | sed 's/^/    /'
  fail "version/toolchain coherence failed (see above)"
fi

# ---- 3. Docs + release artifacts (generic, not version-historical) ----------
section "release artifacts"
for doc in docs/RELEASE-CHECKLIST.md docs/DATABASE-MIGRATIONS.md docs/HOSTED-SECURITY.md docs/HOSTED-DEPLOYMENT.md docs/RC-QA.md; do
  [[ -f "$doc" ]] && ok "$doc present" || fail "$doc missing"
done
if grep -qE 'V0\.2-RELEASE-CHECKLIST|V0\.2-UPGRADE-CHECKLIST' scripts/release-preflight.sh 2>/dev/null; then
  fail "preflight depends on historical V0.2 filenames"
fi

# ---- 4. Migrations: committed, ordered, inventoried --------------------------
section "migrations"
MIGRATIONS_DIR="packages/database/prisma/migrations"
MIGRATIONS_DOC="docs/DATABASE-MIGRATIONS.md"
untracked_migrations=$(git ls-files --others --exclude-standard "$MIGRATIONS_DIR" | head -5)
[[ -z "$untracked_migrations" ]] && ok "no untracked migrations" || fail "untracked migrations: $untracked_migrations"

# Timestamp prefixes must be strictly increasing (Prisma applies them in
# lexical order — a mis-ordered timestamp can silently reorder schema state).
doc_baseline=$(tr '\n' ' ' < "$MIGRATIONS_DOC" | grep -oE 'latest applied[[:space:]]+`[0-9]{14}_[a-z0-9_]+`' | grep -oE '[0-9]{14}_[a-z0-9_]+' | head -1)
if [[ -z "$doc_baseline" ]]; then
  fail "$MIGRATIONS_DOC does not record a production baseline ('latest applied \`…\`') — the inventory doc is the source of truth"
else
  ok "doc-recorded production baseline: $doc_baseline"
  uninventoried=""
  prev=""
  while IFS= read -r name; do
    ts="${name:0:14}"
    if [[ -n "$prev" && "$ts" < "$prev" ]]; then
      fail "migration timestamps not strictly increasing at: $name"
    fi
    prev="$ts"
    if [[ "$name" > "$doc_baseline" ]]; then
      grep -q "${name:0:14}" "$MIGRATIONS_DOC" || uninventoried="$uninventoried $name"
    fi
  done < <(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
  [[ -z "$uninventoried" ]] && ok "every migration after the doc baseline is inventoried" || fail "migrations after the documented baseline NOT in $MIGRATIONS_DOC:$uninventoried"
  # Release rehearsal hook: when the caller knows live production's head
  # (rehearsal time), the doc baseline must agree with it. Never baked in —
  # supplied per-run via env.
  if [[ -n "${RELEASE_EXPECTED_PROD_MIGRATION_HEAD:-}" && "$doc_baseline" != "$RELEASE_EXPECTED_PROD_MIGRATION_HEAD" ]]; then
    fail "doc baseline ($doc_baseline) != RELEASE_EXPECTED_PROD_MIGRATION_HEAD ($RELEASE_EXPECTED_PROD_MIGRATION_HEAD) — update the inventory doc before rehearsing"
  fi
fi

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
  ok "docker-compose.yml valid (prebuilt GHCR images)"
else
  fail "docker-compose.yml invalid"
fi
if POSTGRES_PASSWORD=preflight API_KEY_ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) docker compose -f docker-compose.yml -f docker-compose.build.yml config --quiet >/dev/null 2>&1; then
  ok "docker-compose.yml + build override valid (source-build path)"
else
  fail "docker-compose.yml + docker-compose.build.yml invalid"
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

# ---- 7. Full gates (fail-closed) ----------------------------------------------
section "gates"
pnpm lint >/dev/null 2>&1 && ok "lint" || fail "lint failed"
pnpm typecheck >/dev/null 2>&1 && ok "typecheck" || fail "typecheck failed"
pnpm --filter @tornscope/web exec svelte-kit sync >/dev/null 2>&1 && ok "svelte-kit sync" || fail "svelte-kit sync failed"
pnpm --filter @tornscope/web exec svelte-check --tsconfig ./tsconfig.json >/dev/null 2>&1 && ok "svelte-check" || fail "svelte-check failed"

if [[ $QUICK -eq 0 ]]; then
  if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
    # Bounded workers: unbounded parallelism can exhaust local Postgres
    # connections (CI runners are small enough not to hit this).
    pnpm vitest run --maxWorkers="${PREFLIGHT_TEST_WORKERS:-4}" >/dev/null 2>&1 && ok "full DB-backed test suite" || fail "test suite failed"
  else
    fail "TEST_DATABASE_URL not set — DB-backed tests cannot run (set it and re-run; a preflight without real tests is never a PASS)"
  fi
  pnpm build >/dev/null 2>&1 && ok "build" || fail "build failed"
else
  echo "(--quick: skipping DB-backed test suite + build)"
fi

# ---- Verdict ------------------------------------------------------------------
printf '\n== PREFLIGHT VERDICT ==\n'
for p in "${PASS[@]}"; do printf '  PASS  %s\n' "$p"; done
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  for f in "${FAILURES[@]}"; do printf '  FAIL  %s\n' "$f"; done
  printf '\nPREFLIGHT FAIL (%d failure(s))\n' "${#FAILURES[@]}"
  exit 1
fi
if [[ $QUICK -eq 1 ]]; then
  # A quick run skips the DB-backed suite and the build: it can never be
  # mistaken for a release approval (V1.0 hardening).
  printf '\nPREFLIGHT QUICK PASS — NOT RELEASE APPROVAL\n'
  printf '   (tests + build skipped; run full preflight for a release-grade verdict)\n'
  exit 0
fi
printf '\nPREFLIGHT PASS\n'
