# Public deployment checklist (TornScope)

Complete every item before exposing TornScope on a public hostname
(e.g. `tornscope.example.com` behind your reverse proxy).

## Network
- [ ] Only `web` is publicly reachable (reverse proxy → `web:5173`).
- [ ] PostgreSQL is NOT published (compose binds it to `127.0.0.1:5432` only).
- [ ] Redis is NOT published (no `ports:` entry).
- [ ] API is NOT public (compose binds `127.0.0.1:3100` for host debugging only).

## TLS / proxy
- [ ] Reverse proxy terminates HTTPS and forwards to `web`.
- [ ] Proxy sets `X-Forwarded-Proto` and `X-Forwarded-Host` (web container has
      `PROTOCOL_HEADER=x-forwarded-proto`, `HOST_HEADER=x-forwarded-host`).
- [ ] `ts_session` cookie arrives with `Secure` (verify via devtools over HTTPS).
- [ ] Recommended proxy limits per visitor IP: 60 req/min for pages/API reads;
      10 req/min for `/api/settings/*`, `/api/session/*`, `/api/profile/*`;
      block response codes 429 with `Retry-After`.

## Environment (.env)
- [ ] `PUBLIC_BASE_URL=https://<public-hostname>`
- [ ] `ALLOWED_ORIGINS=https://<public-hostname>` (no wildcards)
- [ ] `TRUST_PROXY=true` (behind proxy) — `false` only for direct exposure
- [ ] `OWNER_BIND_ENABLED=false` after the owner profile is bound
- [ ] `GUEST_PROFILE_RETENTION_DAYS=60` (or preferred retention)
- [ ] `API_KEY_ENCRYPTION_KEY` is unique per installation and backed up

## Identity
- [ ] Owner bound (`/api/me` shows the owner profile) and
      `ownerBindAvailable=false`.
- [ ] New incognito browser gets a fresh `Guest …` profile with zero owner data.

## Jobs & quota
- [ ] Manual Sync / Restart Backfill are credential-gated (guests get no Torn
      API work).
- [ ] Worker maintenance ran at least once (guest/session cleanup log line).

## Health & headers
- [ ] `/api/health` returns `{status:ok}` without cookies and creates no profile.
- [ ] Security headers present: CSP, nosniff, Referrer-Policy, Permissions-Policy.

## Backups
- [ ] `pg_dump` verified restorable (Settings → Data & backups shows the command).
