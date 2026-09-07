# TornScope

**TornScope** is a self-hostable analytics and history portal for [Torn](https://www.torn.com). Connect a Torn API key and get a modern, data-rich dashboard that **continuously collects, normalizes, stores and analyzes historical account data** — not just a mirror of what the API returns today.

> Screenshots: *(placeholder — add screenshots of the dashboard, drugs, money, travel and timeline pages here)*

## Why

Torn's API shows the *present*; it does not give you your financial history, drug usage patterns, travel profitability or networth trends over time. TornScope treats **historical data as a first-class concern**: snapshots and events are stored from your very first successful sync onward, because some data cannot be reconstructed later (Torn's log retention is limited).

The product intentionally combines ideas from Torn.Report (information density, drug analytics) and YATA (reliable tracking), rebuilt on a modern architecture.

## Features (MVP)

| Area | What you get |
| --- | --- |
| **Today (live status)** | The player's day-to-day command view: live bars (energy/nerve/happy/life with regen + full-at countdowns), drug/booster/medical cooldown countdowns, travel state (outbound/returning/abroad with landing timer), city-bank investment maturity, education progress, hospital/jail release notices, and one merged **Upcoming** timeline sorted soonest-first. Countdowns render client-side from absolute Torn timestamps; live state refreshes every 45s while the tab is open (paused when hidden) |
| **Overview dashboard** | KPI cards (net worth, cash, 30d income/expenses/net gain, travel profit, drugs used, rehab spend), networth-over-time chart, income/expense by source, travel profit trend, drug use trend, recent activity |
| **Drugs & rehab** | Daily drug use chart (Good/Bad with zoom), per-drug breakdown with donut, estimated spend from Torn market prices, overdose rate, rehab history & spend |
| **Money** | Unified ledger (single source of truth, deduplicated), income vs expenses over time, cumulative net gain, category breakdowns, filterable + paginated ledger table |
| **Travel** | Trips assembled from logs, estimated profit per trip/hour/destination, plushie vs flower vs other splits, expandable trip history with per-item economics |
| **Timeline** | Unified chronological feed of logs and events with amounts and provenance |
| **Sync system** | BullMQ worker with per-resource schedules, incremental cursors, deduplication, overlap locks, crash recovery, rate limiting, per-resource "Sync now" with cooldown |
| **First run** | Welcome flow: validate key → detect player → encrypted storage → initial sync → dashboard |
| **Demo mode** | `pnpm seed:demo` seeds 180 days of synthetic data for a clearly-marked demo user (never mixed with real data) |
| **Foundation** | Faction, ranked war, organized crime, stocks, combat and progression models/routes exist as clearly-labeled "Coming soon" — no fake data |

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

```bash
git clone <your-repo-url> tornscope && cd tornscope
cp .env.example .env

# generate the encryption master key and put it in .env
node -e "console.log('API_KEY_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"

docker compose up -d --build
```

Open **http://localhost:5173**, follow the welcome flow (paste any Torn API key — limited permissions work too, more access unlocks additional analytics) and the worker starts collecting history immediately.

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

Never commit real secrets.

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
pnpm test       # vitest (128 tests: analytics, money, travel, drugs, rehab,
                #  networth, timeline, today live-state logic, encryption,
                #  log normalization, Torn client retry/pagination/error
                #  taxonomy, cursors, Today selection fixtures)
pnpm typecheck  # strict TypeScript across all packages
pnpm --filter @tornscope/web check   # svelte-check
```

Dev URL: http://localhost:5173 (web) — `/api/*` is proxied to the Fastify server on :3000 in every environment.

## Production deployment

- `docker compose up -d --build` runs postgres, redis, migrate, api, worker and web.
- API/web containers run as a non-root user; database and ports bind to localhost only — put your preferred reverse proxy (Caddy/Nginx/Traefik) with TLS in front for remote access.
- Set `NODE_ENV=production` (the compose file does this) and a strong `API_KEY_ENCRYPTION_KEY`.
- Security posture: Helmet headers, CORS restricted to `APP_BASE_URL`, global rate limiting, Zod validation on every input, keyset pagination (no unbounded queries), parameterized SQL only (Prisma + tagged templates), no secrets in logs.

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

1. Faction analytics (members, armory, chain/war history) on the existing faction foundation
2. Ranked war analytics using the `ranked_war*` tables (payouts vs consumable costs)
3. Crimes / combat / stocks / progression pages (schema ready, sync jobs next)
4. Realized sale matching for travel items (match purchase logs with later sale logs)
5. Multi-user accounts with sessions (auth seam already isolated in `apps/api/src/auth.ts`)
6. Per-user display preferences (timezone, currency)

## License

MIT — see [LICENSE](LICENSE).
