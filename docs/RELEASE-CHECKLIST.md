# TornScope Release Checklist (version-agnostic)

The living checklist for ANY stable release from `develop` → `main`. It is
the release-artifact contract `scripts/release-preflight.sh` validates:
preflight must never depend on a historical version's filename. Historical
per-version certifications (e.g. the V0.2 documents) are kept as history —
they are inputs to a release, not requirements of the next one.

The release version itself is chosen during release engineering (the root
`package.json` version is the canonical source; `scripts/version-check.mjs`
proves the tree is internally coherent whatever it is).

## 1. Tree and branch

- [ ] Work happens on `develop`; production deploys only from `main`.
- [ ] Working tree clean; local == `origin/develop` (preflight enforces).
- [ ] `node scripts/version-check.mjs` passes (versions + pnpm pin coherent).

## 2. Quality gates (fail-closed — no warning-but-pass)

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm --filter @tornscope/web exec svelte-kit sync`
- [ ] `pnpm --filter @tornscope/web exec svelte-check --tsconfig ./tsconfig.json`
- [ ] Full DB-backed suite with `TEST_DATABASE_URL` set (a Postgres instance;
      hosted CI runs the same suite — see `.github/workflows/ci.yml`)
- [ ] `pnpm build`
- [ ] Compose variants validate: `docker compose config -q` for the base,
      dev and unraid files
- [ ] Docker smoke (`scripts/ci/docker-smoke-test.sh`) green

## 3. Database migrations

- [ ] Every migration directory is committed.
- [ ] `docs/DATABASE-MIGRATIONS.md` is the authoritative inventory: every
      migration newer than the doc's recorded production baseline is listed
      with a compatibility classification (`migration-safety.test.ts`
      enforces expand-only / allow-listed).
- [ ] Migration rehearsal against a copy of live production state
      (`scripts/rehearse-prod-upgrade.sh`) has passed for this release.
- [ ] Pre-deploy backup taken per `docs/DATABASE-MIGRATIONS.md`.

## 4. Security posture

- [ ] `docs/HOSTED-SECURITY.md` matches the shipped behavior (rate limits,
      session model, CSRF origin contract, secrets handling).
- [ ] Security regression suites green: security-hardening,
      security-regressions, trust-proxy, trust-proxy-untrusted,
      notifications-security, push-ssrf, multi-user-isolation.
- [ ] No secrets in logs (redaction paths in `apps/api/src/server.ts`).

## 5. Release-specific artifacts (created during release engineering)

- [ ] Release notes document user-visible changes since the last release.
- [ ] Version bumped in root + all workspace `package.json` files (one
      value, enforced by `scripts/version-check.mjs`).
- [ ] Upgrade/upgrade-checklist docs for operators updated when behavior,
      env vars or migrations changed.

## 6. Deployment

- [ ] Dev stack ran the exact release SHA with green gates before promotion.
- [ ] `scripts/deploy-prod.sh` is the only production path: branch/dirty/
      origin guards, migration one-shot gating, readiness probe and the
      build-identity assertion (deploy fails non-zero when the running
      `x-tornscope-build` does not match the deployed commit).
- [ ] Post-deploy: `/api/ready` green, web 200, build header == deployed SHA,
      no new sync failures over the first hours.
