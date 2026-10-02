# TornScope 2.2.0 — Stable Release

Release notes · previous: 2.1.3

TornScope's first regular stable release. The application is already
production-used; this release aligns its presentation, release history and
CI pipeline with that reality. No new features, no analytics changes, no
data model changes, no migration.

## Stable lifecycle

- TornScope is presented as a regular stable release: the "Public Testing"
  lifecycle label is gone from the interface (environment chip, About
  panel, onboarding), the documentation and the deployment defaults
  (production environment label is now "Production").
- The self-hosted framing is unchanged: a self-hosted Torn analytics and
  live-status platform.

## Simplified release history

- The in-app changelog no longer shows per-release dates or lifecycle
  stage labels — versions and their changes only. Historical feature and
  fix descriptions are unchanged.
- GitHub continues to show its own publication timestamps for tags.

## CI reliability

- Fixed the long-standing red CI on main: the demo-data seed step imports
  the `@tornscope/database` package barrel, whose module graph reaches
  `@tornscope/analytics` — on a clean checkout that package's build output
  did not exist, so the seed failed with `ERR_MODULE_NOT_FOUND` and every
  later CI step was skipped. The seed step now builds every internal
  package (pnpm resolves them topologically), verified against a
  clean-checkout reproduction. No checks were weakened, skipped or
  masked.

## Impact

- No API, database or configuration changes for existing deployments.
  The only runtime-visible difference is the environment label
  ("Production" instead of "Public Testing"); deployments can keep
  overriding it with `ENV_LABEL` / `PUBLIC_ENV_LABEL`.

## Upgrade

Standard flow: `deploy-prod.sh`. Running version after upgrade: `2.2.0`.
