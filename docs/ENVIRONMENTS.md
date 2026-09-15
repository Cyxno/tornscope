# Environments: production vs development

TornScope runs as two fully isolated stacks on the same server:

| | **Production** | **Development / staging** |
|---|---|---|
| Branch | `main` | `develop` |
| Checkout on the server | `/workspace/tornscope` | `/workspace/tornscope-dev` |
| Release line | `1.0.0` — Public Testing | next `1.0.x`/`1.1.0-dev` on `develop` |
| URL | https://tornscope.cyxno.eu | https://torn.familievalk.com (private) |
| Compose project | `tornscope` | `tornscope-dev` |
| Compose file | `docker-compose.unraid.yml` | `docker-compose.dev.yml` |
| Env file | `.env` (secrets, never committed) | `.env.dev` (secrets, never committed) |
| Web port | `5173` | `5273` |
| API port (host) | `127.0.0.1:3100` | `127.0.0.1:3101` |
| Postgres | `tornscope-postgres-1`, DB `tornscope`, data in `/mnt/user/appdata/tornscope/postgres` | `tornscope-dev-postgres-1`, DB `tornscope_dev`, data in `/mnt/user/appdata/tornscope-dev/postgres` |
| Redis | `tornscope-redis-1` (internal) | `tornscope-dev-redis-1` (internal) |
| Access control | public (Cloudflare + NPM, TLS) | NPM access list **"Password protection"** (basic auth) at the proxy |
| UI environment chip | **Beta** | **Development** (`PUBLIC_ENV_LABEL`) |

The two stacks share nothing: different containers, networks, volumes, ports,
database names, credentials, encryption keys and VAPID keys. The dev stack can
be built, restarted or destroyed at any time without touching production — and
vice versa.

## Branch model

```
main      production only. Stable public-beta code. Only tested fixes and
          releases are merged here. Protected: no force-push, CI green first.

develop   active work toward the next minor release (v0.2.0). Deploys to the
          dev/staging stack only.

feature/<name>   short-lived, merged into develop
fix/<name>       short-lived, merged into develop
hotfix/<name>    short-lived, branched from main for urgent prod fixes
```

Rules:

- `develop` is created from `main` and is merged back into `main` only when the
  release is done (see "Promoting a release" below). Never rewrite history,
  never force-push.
- Production deploys happen only from `main`, only from a clean, pushed tree —
  `scripts/deploy-prod.sh` enforces this.
- Dev deploys happen only from `develop` — `scripts/deploy-dev.sh` enforces
  this and refuses a dev env file that mentions the production domain.

## Deploying

```bash
# production (from /workspace/tornscope, branch main)
scripts/deploy-prod.sh

# dev/staging (from /workspace/tornscope-dev, branch develop)
scripts/deploy-dev.sh
```

Both scripts build the images, run the `migrate` one-shot (Prisma migrations)
via compose `depends_on`, restart only their own compose project, and wait for
a real `/api/ready` response before reporting success. Both refuse to run from
the wrong branch; both verify the running build via the API's
`x-tornscope-build` header.

## Dev data policy

The dev database holds demo/synthetic data (seeded with `pnpm seed:demo`), not
a live copy of production. If you restore a production dump into the dev stack
for migration testing, treat it as sensitive: mark it temporary, never expose
the dev site publicly without the proxy access list, and destroy it afterwards
(see [DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md)).

## Hotfix workflow (urgent production fix while 0.2 is in development)

1. Branch `hotfix/<name>` from `main`.
2. Fix + test.
3. Merge into `main`, let CI go green.
4. Deploy production (`scripts/deploy-prod.sh`), tag the patch release (e.g. `v0.1.4`).
5. Merge `main` into `develop` (or cherry-pick the fix commit) so 0.2 keeps the fix.

This order guarantees production is never waiting on 0.2 work, and develop never
silently loses a production fix.

## Versioning

- `1.0.0` — first stable release (production: PUBLIC TESTING)
- historical: `0.1.x` — Public Beta 1 (v0.1.3); `0.2.x` — Public Beta 2 line
- `0.2.x` — Beta 2 patch line
- `1.0.0` — first stable release (production environment label: PUBLIC TESTING)
- `develop` carries a non-release version in `package.json`
  (e.g. `0.2.0-dev.0`) and shows a **Development** chip in the UI, so the
  staging site can never be mistaken for the public beta. Production keeps
  showing **Beta**.

## Promoting a release (develop -> main)

1. `develop` is feature-complete and CI is green.
2. Run the required upgrade rehearsal against a copy of the production
   database: `scripts/rehearse-prod-upgrade.sh --from-prod`
   (see [DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md)).
3. Merge `develop` -> `main` (a regular merge, no history rewrite).
4. Tag the release (e.g. `v0.2.0`), set `package.json` on `main` to the release
   version.
5. Deploy production (`scripts/deploy-prod.sh`) and verify `/api/ready` and the
   public site.

## GitHub branch protection (recommended settings)

Configuring branch protection needs GitHub admin permissions in the repo UI or
an authenticated `gh` CLI; if that is not available, apply these manually:

- `main`: require a pull request (or at minimum require the **CI** check to
  pass), disable force pushes and branch deletion.
- `develop`: require the **CI** check to pass; disable force pushes.

## Server-side routing (Nginx Proxy Manager)

- `tornscope.cyxno.eu` -> `192.168.1.2:5173` (production web)
- `torn.familievalk.com` -> `192.168.1.2:5273` (dev web) with the NPM access
  list **"Password protection"** attached, so the dev site is not a public
  instance.

Both domains are Cloudflare-proxied in front of NPM; the `TRUST_PROXY` /
`CLIENT_IP_HEADER` / `CLIENT_IP_DEPTH` settings in each env file describe that
same chain (visitor -> Cloudflare -> NPM -> web).
