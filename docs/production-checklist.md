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
- [ ] `pg_dump` verified restorable. The command lives in Settings → "Server administration · Backups", which is visible ONLY to the server owner (server-derived role, never a client flag); ordinary users see user-focused copy instead of infrastructure details.

## Owner binding / recovery
- The owner is identified EXCLUSIVELY server-side: `User.role == "owner" && !isDemo` on the session's resolved profile. Never from Torn ID, key level, cookies, or client state.
- The bind/recovery token itself NEVER reaches the browser — the API exposes only an `ownerBindAvailable` boolean.
- First bind: set `OWNER_BIND_TOKEN`, bind once from the owner browser; the profile is then permanently claimed.
- Recovery AFTER binding is opt-in and must stay disabled in normal production:
  1. `OWNER_BIND_ENABLED=true` in `.env`, restart the api/worker (`docker compose -f docker-compose.unraid.yml up -d`)
  2. bind from the trusted browser with `OWNER_RECOVERY_TOKEN`
  3. remove `OWNER_BIND_ENABLED` again and restart.
  With the flag unset, the Settings recovery section is hidden for everyone and the bind endpoint refuses re-binding even if a recovery token is present in the environment.
