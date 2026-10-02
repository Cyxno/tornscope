# Environments: production-only runtime

Since the 1.0.0 release, TornScope runs as a **single permanently running
environment** on the server: production. There is no permanently running
dev/staging stack anymore.

| | **Production** |
|---|---|
| Branch | `main` |
| Checkout on the server | `/workspace/tornscope` |
| Release line | `2.2.0` — Production |
| URL | https://tornscope.cyxno.eu |
| Compose project | `tornscope` |
| Compose file | `docker-compose.unraid.yml` |
| Env file | `.env` (secrets, never committed) |
| Web port | `5173` |
| API port (host) | `127.0.0.1:3100` |
| Postgres | `tornscope-postgres-1`, DB `tornscope`, data in `/mnt/user/appdata/tornscope/postgres` |
| Redis | `tornscope-redis-1` (internal) |
| UI environment chip | **Production** |

The old development environment (`tornscope-dev` compose project, DB
`tornscope_dev`, `/workspace/tornscope-dev`, `/mnt/user/appdata/tornscope-dev`,
ports 5273/3101) was removed after 1.0.0.

**`torn.familievalk.com` is no longer an active TornScope environment.**
Its NPM proxy host has been removed; the hostname must not serve TornScope.

## Normal workflow (small fixes)

```
work locally / short-lived branch (fix/<name>)
  → relevant tests
  → merge/push to main
  → hosted CI
  → production deploy (scripts/deploy-prod.sh)
```

Production deploys happen only from `main`, only from a clean, pushed tree —
`scripts/deploy-prod.sh` enforces this, runs the `migrate` one-shot (Prisma
migrations) via compose `depends_on`, restarts only its own compose project,
and waits for a real `/api/ready` response before reporting success.

## Major features / risky migrations

Do not keep a permanent public dev deployment. When a change truly needs an
isolated environment (major feature, risky database migration), create a
**temporary** one, then destroy it completely afterwards:

- `scripts/deploy-dev.sh` + `docker-compose.dev.yml` can still bootstrap a
  temporary dev stack on a scratch checkout (e.g. `/workspace/tornscope-dev`),
  with DB `tornscope_dev`, ports 5273/3101.
- For migration rehearsal against a copy of production data, use
  `scripts/rehearse-prod-upgrade.sh --from-prod`
  (see [DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md)).
- Destroy all temporary runtime state when done: compose project, network,
  containers, DB data directory, checkout, and the NPM proxy host if one was
  created. Never leave a temporary stack running.

## Branch model

```
main      production only. Stable code. Only tested fixes and releases are
          merged here. Protected: no force-push, CI green first.

develop   historical integration branch (kept on the remote for history /
          convenience; no longer deployed anywhere). May be reused as the
          base for future temporary environments.

feature/<name>   short-lived, merged into main
fix/<name>       short-lived, merged into main
hotfix/<name>    short-lived, branched from main for urgent prod fixes
```

Rules:

- Never rewrite history, never force-push.
- Deploys happen only from `main`, only from a clean, pushed tree.

## Dev data policy (temporary environments only)

A temporary environment's database holds demo/synthetic data (seeded with
`pnpm seed:demo`), not a live copy of production. If you restore a production
dump into a temporary stack for migration testing, treat it as sensitive:
mark it temporary, never expose it publicly without an access list, and
destroy it afterwards (see [DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md)).

## Hotfix workflow (urgent production fix)

1. Branch `hotfix/<name>` from `main`.
2. Fix + test.
3. Merge into `main`, let CI go green.
4. Deploy production (`scripts/deploy-prod.sh`), tag the patch release (e.g. `v1.0.1`).

## Versioning

- `2.2.0` — first stable release (production: PRODUCTION); historical: `1.0.0`–`2.1.x` shipped under the public-testing label
- historical: `0.1.x` — Public Beta 1 (v0.1.3); `0.2.x` — Public Beta 2 line
- patch releases increment `package.json` on `main` (e.g. `1.0.1`) and are
  tagged (`v1.0.x`).

## Promoting a release

1. Work is merged into `main` and CI is green.
2. For risky database migrations, run the upgrade rehearsal against a copy of
   the production database first: `scripts/rehearse-prod-upgrade.sh --from-prod`
   (see [DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md)).
3. Tag the release (e.g. `v1.0.1`), set `package.json` on `main` to the release
   version.
4. Deploy production (`scripts/deploy-prod.sh`) and verify `/api/ready` and the
   public site.

## GitHub branch protection (recommended settings)

Configuring branch protection needs GitHub admin permissions in the repo UI or
an authenticated `gh` CLI; if that is not available, apply these manually:

- `main`: require a pull request (or at minimum require the **CI** check to
  pass), disable force pushes and branch deletion.
- `develop` (if kept): require the **CI** check to pass; disable force pushes.

## Server-side routing (Nginx Proxy Manager)

- `tornscope.cyxno.eu` -> `192.168.1.2:5173` (production web) — the only
  TornScope proxy host.

`familievalk.com` hostnames are no longer routed to any TornScope stack. The
production domain is Cloudflare-proxied in front of NPM; the `TRUST_PROXY` /
`CLIENT_IP_HEADER` / `CLIENT_IP_DEPTH` settings in the env file describe that
same chain (visitor -> Cloudflare -> NPM -> web).
