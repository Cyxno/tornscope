# Configuration reference

TornScope is configured through environment variables in `.env` (see
[.env.example](../.env.example) — the annotated source of truth). Defaults
work on `http://localhost:5173` with zero changes; anything beyond localhost
is covered in [REVERSE-PROXY.md](REVERSE-PROXY.md).

## Required

| Variable | Purpose | Generate |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Database password — the compose file refuses to start without it | `openssl rand -hex 16` |
| `API_KEY_ENCRYPTION_KEY` | 64-hex-char master key for AES-256-GCM encryption of stored Torn API keys | `openssl rand -hex 32` |

> Losing `API_KEY_ENCRYPTION_KEY` means stored API keys can no longer be
> decrypted. Back it up — see [BACKUP.md](BACKUP.md).

## Connections (Docker Compose)

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_DB` | `tornscope` | Provisioned by the postgres container |
| `DATABASE_URL` | localhost URL | Not used by the compose services — they get the Docker-internal URL from the compose files. Relevant only for non-Docker development |
| `REDIS_URL` | `redis://localhost:6379` | Same note; compose services use `redis://redis:6379` |
| `API_PORT` | `3000` | Port the API listens on |
| `API_BASE_URL` | `http://localhost:3000` | Where the web app proxies API requests server-side |

## Origins and proxy (non-local deployments)

| Variable | Purpose |
| --- | --- |
| `APP_BASE_URL` | Web origin used for CORS and demo links (API) |
| `ORIGIN` | Browser-facing origin of the web app (SvelteKit) — must match what users actually open |
| `PUBLIC_BASE_URL` | Public origin users browse; informational, and the default VAPID subject source |
| `ALLOWED_ORIGINS` | Comma-separated extra origins for cookie-authenticated mutations |
| `TRUST_PROXY` | `true` (one trusted proxy hop — default), `false`, or a proxy-addr subnet list matching the real chain |
| `CLIENT_IP_HEADER` / `CLIENT_IP_DEPTH` | Real client-IP header and proxy-chain depth for per-IP rate limits |

Misconfigured origins break session-cookie security, CSRF/origin checks,
Web Push and per-IP rate limiting — see [REVERSE-PROXY.md](REVERSE-PROXY.md).

## Web Push (optional)

| Variable | Purpose |
| --- | --- |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | VAPID key pair identifying your instance to browser push services. Generate once with `npx web-push generate-vapid-keys`. Push stays disabled until both are present |
| `VAPID_SUBJECT` | Contact URI sent with every push. Must be an `https://` origin or a `mailto:` on a real domain — Apple's push service rejects reserved-TLD subjects (e.g. `*.local`) with 403 BadJwtToken. Defaults to `PUBLIC_BASE_URL` when it is an https origin |

## Sync and Torn API

| Variable | Default | Purpose |
| --- | --- | --- |
| `TORN_API_BASE_URL` | `https://api.torn.com/v2` | Override only for testing/proxying |
| `TORN_API_MIN_REQUEST_INTERVAL_MS` | `700` | Spacing between Torn requests (cap is ~100/min) |
| `TORN_SYNC_INITIAL_HISTORY_DAYS` | `180` | Initial history window on first sync (max 180) |
| `SYNC_INTERVAL_*` | per resource | Schedule overrides in seconds (profile, events, drugs, travel, money logs, networth, personal stats, faction basic, torn catalog) |
| `TODAY_CACHE_TTL_MS` | `30000` | /api/today response cache (countdowns render client-side) |

## Operational

| Variable | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | pino log level |
| `GUEST_PROFILE_RETENTION_DAYS` | `60` | Cleanup of abandoned anonymous profiles |
| `HOSTED_MAX_SESSIONS_PER_PROFILE` | `10` | Active sessions per profile |
| `HOSTED_PROFILE_CREATIONS_PER_IP_PER_HOUR` | `20` | Anonymous profile creations per IP per hour |
| `HOSTED_MAX_PUSH_DEVICES` | `10` | Active push devices per profile (clear error at the cap) |

The `HOSTED_*` limits are abuse bounds for publicly reachable instances;
security basics (auth, CSRF, SSRF, isolation) never depend on them.
