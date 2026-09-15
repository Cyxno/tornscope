# Hosted Deployment Guide

The supported single-node topology and every setting that matters for
running it safely. Self-hosters on a trusted LAN can skip the hosted-only
items; nothing here is required for local use.

## Supported topology

```
Internet → Cloudflare (TLS, cache) → Nginx Proxy Manager (per-host TLS if
no Cloudflare) → TornScope web (SvelteKit, same-origin /api proxy) → API
(loopback) → Postgres (loopback) / Redis (internal network) / worker
(internal, outbound to Torn + push providers)
```

## Rules that matter

1. **Never publish the API port.** Compose binds it to `127.0.0.1`. The web
   app's same-origin proxy is the only supported front door — it owns real
   client-IP resolution (`CLIENT_IP_HEADER`, e.g. `cf-connecting-ip`, and
   `CLIENT_IP_DEPTH` for the proxy hop count) and forwards exactly one
   authoritative `X-Forwarded-For` value.
2. **Trust exactly your proxy chain.** Default `TRUST_PROXY=true` trusts the
   adjacent hop — correct when the API is loopback-only behind the proxy.
   If you expose the API directly, set `TRUST_PROXY=false` (or an explicit
   subnet list). Never leave `true` on a directly reachable port: clients
   could spoof `X-Forwarded-For` to escape rate-limit buckets.
3. **Databases stay internal.** Redis is never published (no `ports:`) and
   has no password by design — network isolation is the control; adding
   `--requirepass` + a matching `REDIS_URL` is recommended extra hardening
   for shared Docker hosts. Production Postgres binds `127.0.0.1` with a
   generated password (`POSTGRES_PASSWORD` is required; compose refuses to
   start without it).
4. **Cloudflare/API caching:** do not cache `/api/*`. Every API response is
   already `cache-control: private, no-store`, and the proxy defaults to
   `no-store` — keep any Cloudflare page/cache rule from overriding that
   for authenticated JSON.
5. **Secrets** (generate per install; never commit):
   - `API_KEY_ENCRYPTION_KEY` — 64 hex chars (`openssl rand -hex 32` ×? use
     `openssl rand -hex 32` for 32 bytes / 64 hex). Rotating it invalidates
     stored Torn keys (they are AES-GCM sealed with it).
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — generate with
     `npx web-push generate-vapid-keys`. Required for notifications; the
     worker receives them too (compose passes both services).
   - `SESSION_SECRET`-less model: session tokens are random and hashed —
     nothing else to rotate.
6. **Timeouts/body size at the proxy:** NPM default client body limit is
   fine (TornScope enforces 256 KiB itself); no WebSocket endpoints exist;
   recommended proxy read timeout ≥ 60s for cold analytics on slow disks.
7. **Backups:** nightly `pg_dump` (see docs/DATABASE-MIGRATIONS.md) — the
   hosted dataset is the analytics history users cannot re-import for free.

## Hosted limits (env-tunable)

| Variable | Default | Meaning |
|---|---|---|
| `HOSTED_MAX_SESSIONS_PER_PROFILE` | 10 | Active sessions per profile; stalest revoked beyond cap |
| `HOSTED_PROFILE_CREATIONS_PER_IP_PER_HOUR` | 20 | Anonymous profile creations per IP/hour |
| `HOSTED_MAX_PUSH_DEVICES` | 10 | Active push devices per profile (clear error at cap) |
| `GUEST_PROFILE_RETENTION_DAYS` | 60 | Idle empty guest cleanup age |

Hard limits that do NOT scale with these (per-route 429 buckets) are listed
in [HOSTED-SECURITY.md](HOSTED-SECURITY.md) §2 and are code-centralized so
they cannot drift per service.

## Container hardening

All three app services (api/worker/web) run with:

```yaml
security_opt: ["no-new-privileges:true"]
cap_drop: [ALL]
read_only: true
tmpfs: ["/tmp"]
```

Postgres/Redis/migrate keep official-image semantics (migrate writes
nothing locally; postgres owns its volume; redis is internal). If you add a
service that needs the Docker socket, host PID/network, or a writable
rootfs — don't.

## Dependency policy

`pnpm audit --production` on every release. Known advisories are assessed
for the actual runtime path before upgrading (e.g. the `deepmerge-ts`
advisory only executes inside the Prisma CLI migrate container against
trusted local files). No blind major-version bumps; lockfile updates ride
the normal release flow.

## Incident quick reference

See [HOSTED-SECURITY.md](HOSTED-SECURITY.md) §12 (secret rotation, session
revocation, limit tightening).
