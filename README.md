# TornScope

**TornScope** is a self-hostable analytics and history portal for [Torn](https://www.torn.com). Connect a Torn API key and get a modern, data-rich dashboard that **continuously collects, normalizes, stores and analyzes historical account data** — not just a mirror of what the API returns today.

> **Public Beta** — TornScope is an independent community project, currently released as
> **v0.2 (Public Beta 2)**. It is not operated, endorsed, or hosted by Torn.
> See [Public beta — what to expect](#public-beta--what-to-expect) and
> [Contact & private deployments](#contact--private-deployments).

## Why

Torn's API shows the *present*; it does not give you your financial history, drug usage patterns, travel profitability or networth trends over time. TornScope treats **historical data as a first-class concern**: snapshots and events are stored from your very first successful sync onward, because some data cannot be reconstructed later (Torn's log retention is limited).

The product intentionally combines ideas from Torn.Report (information density, drug analytics) and YATA (reliable tracking), rebuilt on a modern architecture.

## Features

| Area | What you get |
| --- | --- |
| **Today (live status)** | The player's day-to-day command view: live bars (energy/nerve/happy/life with regen + full-at countdowns), drug/booster/medical cooldown countdowns, travel state (outbound/returning/abroad with landing timer), city-bank investment maturity, education progress, hospital/jail release notices, and one merged **Upcoming** timeline sorted soonest-first. Countdowns render client-side from absolute Torn timestamps; live state refreshes every 45s while the tab is open (paused when hidden) |
| **Overview dashboard** | KPI cards (net worth, cash, 30d income/expenses/net gain, travel profit, drugs used, rehab spend), networth-over-time chart, income/expense by source, travel profit trend, drug use trend, recent activity |
| **Drugs & rehab** | Daily drug use chart (Good/Bad with zoom), per-drug breakdown with donut, estimated spend from Torn market prices, overdose rate, rehab history & spend |
| **Money** | Unified ledger (single source of truth, deduplicated), income vs expenses over time, cumulative net gain, category breakdowns, filterable + paginated ledger table |
| **Travel** | Trips assembled from logs, estimated profit per trip/hour/destination (valued at current catalog prices — estimated, not historical sale prices), plushie vs flower vs other splits, expandable trip history with per-item economics |
| **Timeline** | Unified chronological feed of logs and events with amounts and provenance |
| **Sync system** | BullMQ worker with per-resource schedules, incremental cursors, deduplication, overlap locks, crash recovery, rate limiting, per-resource "Sync now" with cooldown |
| **First run** | Welcome flow: validate key → detect player → encrypted storage → initial sync → dashboard |
| **Demo mode** | `pnpm seed:demo` seeds 180 days of synthetic data for a clearly-marked demo user (never mixed with real data) |
| **Progression & energy** | Battlestat progression from hourly snapshots (deltas, milestones with crossing windows), an energy ledger from 5-minute bar snapshots (sources, uses, cap time, unattributed spend), conservatively inferred training sessions with gain-per-energy vs your own baselines, and happy-jump inference (likely/possible — never "confirmed") with full evidence disclosure |
| **Economy** | Four related lenses over the same money — cash movement, asset conversions, economic effect and net worth — with wallet reconciliation (opening/closing/residual), category tables marked earned vs conversion, cumulative movement, and a shareable range/lens URL state |
| **Stocks** | Ownership and stock-benefit intelligence: positions valued at the current market price, benefit blocks (reached/next), missing shares and estimated cost, derived payout timing, estimated reward value (exact cash or catalog-priced items — unvalued rewards are never faked), annual benefit, yield and payback |
| **Merits** | The full merit ledger: exact ranks, unspent points, category concentration, maxed/partial/untouched states, per-merit descriptions from Torn's official catalog, search and filters |
| **Themes & settings** | System/Light/Dark themes, seven accent colors, five chart palettes, interface density and motion preferences — applied before first paint, stored per browser, live-previewed in a tabbed Settings center |
| **Notifications** | Web push with a canonical type registry, quiet hours that defer instead of dropping (stale alerts expire), per-profile dedupe across devices, quiet-hours bypass only for access-loss alerts, test push, and a delivery ledger that explains every suppressed or expired alert |
| **Data confidence** | Every figure carries an honest coverage state (complete / partial / stale permission / unavailable). Unavailable renders as "—", never zero |
| **Foundation** | Faction, ranked war, organized crime and stocks routes exist as clearly-labeled "Coming soon" — no fake data |

## Architecture

```
Torn API v2
   │  (HTTPS, Authorization header, client-side rate limiter)
   ▼
apps/worker ── BullMQ/Redis ──► synchronization workers
   │                              • incremental log/event sync with cursors
   │                              • snapshot scheduling (networth, stats)
   │                              • dedup via unique constraints
   ▼
normalization layer (packages/database/normalizers)
   • raw Torn log entries → drug / rehab / travel / money / timeline events
   • route by each entry's own category title (resolved at runtime)
   • defensive field extraction; raw payloads kept in JSONB
   ▼
PostgreSQL (Prisma ORM)  ── events + snapshots (see below)
   ▼
analytics (packages/analytics, pure functions)
   • aggregateMoneyEvents, calculateTravelProfit, calculateDrugStats, ...
   ▼
apps/api (Fastify + Zod)  ── typed, paginated, aggregation endpoints
   ▼
apps/web (SvelteKit + Tailwind + ECharts)  ── /api proxy → apps/api
```

**Events vs snapshots.** *Events* are individual historical occurrences (drug use, rehab visit, flight, item purchase, money movement). *Snapshots* are point-in-time state (networth breakdown, personal stats, player level/faction). Both are append-only and never mixed.

### Monorepo layout

```
tornscope/
├── apps/
│   ├── web/          SvelteKit 5 + Svelte 5 + Tailwind 4 + ECharts 6
│   ├── api/          Fastify 5 + Zod
│   └── worker/       BullMQ sync workers + scheduler
├── packages/
│   ├── torn-api/     Torn API v2 client (rate limiter, retry, error taxonomy,
│   │                 pagination via _metadata.links.next, typed endpoints)
│   ├── database/     Prisma schema + client, idempotent repositories,
│   │                 log normalizers, AES-256-GCM encryption service, demo seed
│   ├── analytics/    Pure calculation functions (no I/O)
│   ├── shared/       Branding, date-range presets, Torn constants, API contracts
│   └── ui/           Reserved for shared design tokens (tokens live in web/app.css)
├── docker/           Production Dockerfiles (api, worker, web)
├── docs/             Notes (Torn API usage reference)
├── docker-compose.yml
└── prisma/           (inside packages/database)
```

## Requirements

- Docker + Docker Compose (recommended), **or**
- Node.js ≥ 20.19, PostgreSQL 14+, Redis 6+, pnpm ≥ 9

## Quick start (Docker)

Fresh install, nothing else required — the two secret commands below write
generated values straight into `.env` (no copy/pasting secrets by hand):

**Linux / macOS:**

```bash
git clone https://github.com/Cyxno/tornscope.git tornscope && cd tornscope
cp .env.example .env

# Database password (hex: URL-safe, no quoting or encoding pitfalls)
sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env && rm .env.bak

# API key encryption master key (32 bytes = 64 hex chars, AES-256-GCM)
sed -i.bak "s/^API_KEY_ENCRYPTION_KEY=.*/API_KEY_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env && rm .env.bak

docker compose up -d --build
```

**Windows PowerShell** (5.1 or later):

```powershell
git clone https://github.com/Cyxno/tornscope.git tornscope
cd tornscope
Copy-Item .env.example .env

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$pgBytes  = [byte[]]::new(16); $rng.GetBytes($pgBytes)   # database password
$keyBytes = [byte[]]::new(32); $rng.GetBytes($keyBytes)  # AES-256 master key
$pgPassword = -join ($pgBytes  | ForEach-Object { $_.ToString("x2") })
$masterKey  = -join ($keyBytes | ForEach-Object { $_.ToString("x2") })

(Get-Content .env -Encoding UTF8) | ForEach-Object {
  $_ -replace '^POSTGRES_PASSWORD=.*$', "POSTGRES_PASSWORD=$pgPassword" -replace '^API_KEY_ENCRYPTION_KEY=.*$', "API_KEY_ENCRYPTION_KEY=$masterKey"
} | Set-Content .env -Encoding UTF8

docker compose up -d --build
```

Both variants leave every other value at its localhost default, which works
out of the box. Exposing TornScope beyond localhost requires extra origin
configuration — see [Running TornScope outside localhost](#running-tornscope-outside-localhost).

Then open **http://localhost:5173**, follow the welcome flow (paste any Torn API key — limited permissions work too, more access unlocks additional analytics) and the worker starts collecting history immediately.

## Public beta — what to expect

TornScope is in public beta. In practice that means:

- Historical tracking and analytics are actively being refined — figures can change as normalization improves.
- Updates may include occasional fixes and database migrations during beta. With Docker Compose, migrations apply automatically on startup.
- Collected history is stored server-side and is intentionally kept across updates, but self-hosters should maintain their own backups (see [Backup recommendations](#backup-recommendations)).
- Bugs and edge cases are expected. Reports are welcome — see [Contact & private deployments](#contact--private-deployments).

Beta does not mean careless: sync, encryption and session security are treated as stable foundations. It does mean you should not bet irreplaceable data on zero changes — keep backups.

## Contact & private deployments

TornScope is maintained by **Cyxno** — reach out on Torn:
[profiles.php?XID=1816206](https://www.torn.com/profiles.php?XID=1816206).

Good reasons to write:

- You found a bug or beta rough edge (a short description + what you expected is perfect).
- You need help with a self-hosted install.
- You would prefer a **private TornScope Docker deployment** (privately hosted, or a private/request-only install arrangement) instead of the public beta — ask, and availability can be discussed.

Notes:

- The public beta can be self-hosted by anyone; private deployment/assistance is an optional arrangement, not a paid product.
- TornScope is an independent community project — **not an official Torn service**. Support is best-effort; there is no commercial SLA.
- Once the repository becomes public, GitHub Issues will be the preferred channel for bug reports. Until then, contact Cyxno directly.

## Instance access model — read before exposing TornScope

TornScope currently does not provide an instance-owner login or invite-only
mode. **Any visitor who can reach your instance can create their own browser
profile and connect a Torn API key.** Publicly exposing an instance is
effectively open registration.

What this means:

- Profiles are isolated server-side — each browser session only sees its own data, and API keys are never shared between users.
- But TornScope itself ships **no access control for who may reach the instance**. If you self-host privately, restrict access with an external layer in front of the `web` container:
  - reverse-proxy authentication (e.g. Nginx basic auth / Authelia / Authentik),
  - a VPN or overlay network (Tailscale, WireGuard),
  - Cloudflare Access,
  - or simply keeping the instance bound to localhost/LAN behind your firewall.

TornScope does not provide these controls itself — it stays intentionally
domain-neutral and out of your network path.



## Environment variables

See [.env.example](.env.example). Highlights:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (Prisma) |
| `REDIS_URL` | Redis for BullMQ queues |
| `TORN_API_BASE_URL` | Defaults to `https://api.torn.com/v2` |
| `API_KEY_ENCRYPTION_KEY` | **Required.** 32-byte hex master key for AES-256-GCM |
| `TORN_API_MIN_REQUEST_INTERVAL_MS` | Minimum spacing between Torn requests (default 700ms ≈ 85/min vs Torn's 100/min cap) |
| `TORN_SYNC_INITIAL_HISTORY_DAYS` | Initial history window on first sync (default 180 days of available Torn history — retention varies by Torn log type) |
| `SYNC_INTERVAL_*` | Per-resource schedule overrides (seconds) |
| `APP_BASE_URL` / `API_BASE_URL` | Web origin for CORS / API target for the web proxy |
| `ORIGIN` | Browser-facing origin of the web app (SvelteKit). MUST match what users actually open |
| `PUBLIC_BASE_URL` | Public origin users browse (informational + push-settings hint) |
| `ALLOWED_ORIGINS` | Extra origins accepted for cookie-authenticated mutations |
| `TRUST_PROXY` | Proxy trust for the API: `true` / `false` / proxy-addr subnet list |
| `CLIENT_IP_HEADER` / `CLIENT_IP_DEPTH` | Real client-IP resolution behind a reverse proxy (web → API) |

Never commit real secrets.

## Running TornScope outside localhost

TornScope defaults to a **local development setup** and works on
`http://localhost:5173` with zero extra configuration. The moment TornScope is
reached any other way — a LAN hostname/IP, a reverse proxy (Nginx Proxy
Manager, Caddy, Traefik, …) or a public domain — the environment MUST match
the address users actually open in their browser. Otherwise, in the best case,
pages render but sessions and push break silently; in the worst case, session
cookies lose their `Secure` flag, CSRF/origin protection rejects every
mutation, Web Push / service workers stop working (browsers only expose them
in secure contexts), and rate limiting buckets every visitor onto one shared
IP.

**Local development** (works out of the box, shown for reference):

```bash
APP_BASE_URL=http://localhost:5173
PUBLIC_BASE_URL=
ALLOWED_ORIGINS=http://localhost:5173
ORIGIN=http://localhost:5173
```

**Public deployment** on `https://torn.example.com` (replace with YOUR domain —
TornScope never assumes one):

```bash
APP_BASE_URL=https://torn.example.com
PUBLIC_BASE_URL=https://torn.example.com
ALLOWED_ORIGINS=https://torn.example.com
ORIGIN=https://torn.example.com
```

> **Warning**
> Do not leave a public production deployment configured for localhost —
> session-cookie security, origin checks and push all depend on the origin
> configuration matching reality.

### Reverse proxies, protocol and client IP

An HTTPS deployment behind a reverse proxy must correctly forward:

- **host** — `X-Forwarded-Host` (the web container already trusts it via
  `HOST_HEADER=x-forwarded-host`, set by both compose files);
- **protocol** — `X-Forwarded-Proto: https` (trusted via
  `PROTOCOL_HEADER=x-forwarded-proto`), so the session cookie gets its
  `Secure` flag;
- **client IP / proxy chain** — the web app forwards one resolved client
  address to the API as `X-Forwarded-For`, where it drives per-IP rate
  limits and the anonymous-profile creation limiter. Configure how the web
  app resolves it:
  - direct access / localhost: nothing to set (the socket address is used);
  - a single reverse proxy (e.g. Nginx Proxy Manager):
    `CLIENT_IP_HEADER=x-forwarded-for` (depth `1` is the default — the
    address your proxy appended wins, a client-spoofed `X-Forwarded-For`
    value is ignored);
  - an additional upstream proxy such as Cloudflare: either
    `CLIENT_IP_HEADER=cf-connecting-ip`, or
    `CLIENT_IP_HEADER=x-forwarded-for` with `CLIENT_IP_DEPTH` equal to the
    number of proxies that append to the chain (e.g. `2` for
    Cloudflare → Nginx Proxy Manager).

  Getting this wrong does not just mislabel logs: with no header configured
  every visitor shares the proxy's rate-limit bucket; with the depth guessed
  too high an attacker can spoof a fresh IP per request. The trusted
  proxy depth/chain must reflect the actual deployment — never guess it.

- **`TRUST_PROXY`** (API) — controls whether Fastify honors `X-Forwarded-*`
  at all. `true` (default) trusts the web app's own proxy hop, `false` is
  only for direct unproxied exposure, and a proxy-addr subnet list (e.g.
  `10.0.0.0/8,192.168.0.0/16` or the `loopback` preset) pins the exact
  proxy IPs. Behind Cloudflare or any multi-proxy setup, configure the value
  to match the actual chain rather than leaving the default guessed —
  Cloudflare is NOT mandatory; without it a single proxy is enough.

Incorrect deployment-origin configuration can break: **Secure session
cookies**, **CSRF/origin protection**, **Web Push / Service Workers**
(browsers require a secure context), **browser secure-context behavior**, and
**client-IP rate limiting**.

## Torn API usage

Endpoints used (all v2, authenticated via the `Authorization: ApiKey` header — the key never appears in URLs or logs):

- `/key/info` — validation, access level, log permissions
- `/user/basic`, `/user/profile` — identity, level, faction, status
- `/user/bars` — live energy/nerve/happy/life with absolute full times
- `/user/cooldowns` — drug/booster/medical seconds remaining (ready-at derived server-side)
- `/user/education` + `/torn/education` — current course, completion time, course names
- `/user/travel` — current travel state (linked to historical trips when flying home)
- `/user/money` — exact cash positions + city bank investment (Today)
- `/user/networth` — full category breakdown (exact)
- `/user/personalstats?cat=all` — long-term stat snapshots
- `/user/log?cat=…&from=…` + `_metadata.links.next` pagination — drugs, rehab, travel, money history
- `/user/events` — timeline events
- `/faction/basic` — faction identity and snapshots
- `/torn/items` — public item catalog with market prices (drives clearly-labeled **estimated** resale values)
- `/torn/logcategories` — resolved at runtime; no undocumented category IDs are hardcoded

Torn rate limits (100 req/min per user) are respected by a centralized client-side limiter, request spacing, backoff on Torn error codes 5/8/17, and a concurrency-1 worker.

## Database migrations

```bash
pnpm db:generate          # prisma generate
pnpm db:migrate           # prisma migrate deploy (against DATABASE_URL)
```

With Docker Compose, the `migrate` service applies migrations automatically before the API/worker start.

Migration rules, the expand/migrate/contract strategy and the required pre-release upgrade rehearsal: [docs/DATABASE-MIGRATIONS.md](docs/DATABASE-MIGRATIONS.md).

## API key security

- Keys are validated against `/key/info`, then encrypted with **AES-256-GCM** (env-supplied master key, unique IV per save, auth-tag verified on decrypt).
- Only the last 4 characters are ever displayed again (`••••abcd`).
- The key is decrypted **only** in the service that performs outgoing Torn requests (API validation and the worker), never sent to the browser, never logged (pino redaction + client-level sanitization as defense in depth).
- Deleting the key in Settings revokes it; collected history is preserved.

## Demo mode

```bash
pnpm seed:demo
```

Seeds 180 days of synthetic history (drugs, rehab, travel with plushies/flowers, money ledger, networth snapshots, timeline) for a dedicated `isDemo = true` user. The UI shows a **Demo mode** banner. Demo rows use `source = 'demo'` and a separate user — they are never mixed with a real player's data. Re-running the command replaces demo data only.

## Development

```bash
pnpm install
cp .env.example .env        # fill DATABASE_URL, REDIS_URL, API_KEY_ENCRYPTION_KEY
docker compose up -d postgres redis
pnpm db:migrate && pnpm db:generate

pnpm dev        # tsc watch + api + worker + web (vite) concurrently
pnpm test        # vitest (analytics, money, travel, drugs, rehab,
                #  networth, timeline, today live-state logic, encryption,
                #  log normalization, Torn client retry/pagination/error
                #  taxonomy, cursors, Today selection fixtures, auth/push
                #  security regressions)
pnpm typecheck  # strict TypeScript across all packages
pnpm --filter @tornscope/web check   # svelte-check
```

Dev URL: http://localhost:5173 (web) — `/api/*` is proxied to the Fastify server on :3000 in every environment.

## Production deployment

- `docker compose up -d --build` runs postgres, redis, migrate, api, worker and web.
- **Non-local access requires configuration** — see [Running TornScope outside localhost](#running-tornscope-outside-localhost) before exposing TornScope on a LAN address, reverse proxy or public domain.
- **Open access model** — TornScope has no instance-owner login or invite-only mode; anyone who can reach the instance can create a browser profile and connect an API key. See [Instance access model](#instance-access-model--read-before-exposing-tornscope) before exposing TornScope publicly.
- Because the compose images keep the same `tornscope-*:latest` tags, every rebuild leaves the superseded image dangling. Run `docker image prune -f` after deploying — it only removes untagged (unused) images, never active containers, volumes or database data.
- API/web containers run as a non-root user; database and ports bind to localhost only — put your preferred reverse proxy (Caddy/Nginx/Traefik) with TLS in front for remote access.
- Set `NODE_ENV=production` (the compose file does this) and a strong `API_KEY_ENCRYPTION_KEY`.
- Security posture: Helmet headers, CORS restricted to the configured origins, global rate limiting keyed on the real client IP, Zod validation on every input, push-endpoint validation (no private/internal push targets), keyset pagination (no unbounded queries), parameterized SQL only (Prisma + tagged templates), no secrets in logs.

- TornScope runs **production** (`main`) and **development/staging** (`develop`) as two fully isolated stacks — separate branches, domains, ports, containers, volumes, databases and secrets. Branching, deploys, hotfixes and releases are documented in [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md); migration rules and the required pre-release upgrade rehearsal in [docs/DATABASE-MIGRATIONS.md](docs/DATABASE-MIGRATIONS.md).


## Backup recommendations

The PostgreSQL volume holds history that **may be unrecoverable from Torn later**. Schedule:

```bash
docker compose exec postgres pg_dump -U tornscope tornscope | gzip > tornscope-$(date +%F).sql.gz
```

Keep off-site copies. Test restores.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| API refuses to start | `API_KEY_ENCRYPTION_KEY` missing or not 64 hex chars |
| "No sync configuration yet" | No API key saved yet — finish the welcome flow / Settings |
| Sync shows `access_denied` / `capability_denied` on log resources | Your key does not include the User Logs selection — grant it in Torn or replace the key in Settings |
| Data stops updating | Check Sync Status errors + `docker compose logs worker` |
| Torn errors `code 5` / `code 8` | Rate limited / IP block — increase `TORN_API_MIN_REQUEST_INTERVAL_MS` |
| Charts empty right after onboarding | First sync (up to 180 days of available Torn history) takes a few minutes; retention varies by Torn log type — watch Sync Status |

## Roadmap

The active plan for **v0.2.0 — Public Beta 2** (Data Confidence + Daily Summary) lives in [docs/ROADMAP.md](docs/ROADMAP.md), including the release blockers. The longer-term backlog:

1. Faction analytics (members, armory, chain/war history) on the existing faction foundation
2. Ranked war analytics using the `ranked_war*` tables (payouts vs consumable costs)
3. Crimes / combat / stocks / progression pages (schema ready, sync jobs next)
4. Realized sale matching for travel items (match purchase logs with later sale logs)
5. Multi-user accounts with sessions (auth seam already isolated in `apps/api/src/auth.ts`)
6. Per-user display preferences (timezone, currency)

## License

MIT — see [LICENSE](LICENSE).
