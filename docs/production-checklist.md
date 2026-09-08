# Public deployment checklist (TornScope)

Complete every item before exposing TornScope on a public hostname
(e.g. `torn.example.com` behind your reverse proxy). TornScope is
domain-neutral: it never assumes a hostname, but every non-local deployment
MUST configure its environment to match the address users actually open.
See README "Running TornScope outside localhost" for background.

## Network
- [ ] Only `web` is publicly reachable (reverse proxy → `web:5173`).
- [ ] PostgreSQL is NOT published (compose binds it to `127.0.0.1:5432` only).
- [ ] Redis is NOT published (no `ports:` entry).
- [ ] API is NOT public (compose binds `127.0.0.1:3100` for host debugging only).

## TLS / proxy
- [ ] Reverse proxy terminates HTTPS and forwards to `web`.
- [ ] Proxy sets `X-Forwarded-Proto` and `X-Forwarded-Host` (web container has
      `PROTOCOL_HEADER=x-forwarded-proto`, `HOST_HEADER=x-forwarded-host`).
- [ ] Real client-IP resolution configured for the deployment:
      - single reverse proxy (e.g. Nginx Proxy Manager):
        `CLIENT_IP_HEADER=x-forwarded-for` (default depth 1);
      - Cloudflare in front: `CLIENT_IP_HEADER=cf-connecting-ip`, or
        `CLIENT_IP_HEADER=x-forwarded-for` with `CLIENT_IP_DEPTH` matching the
        number of appending proxies (e.g. 2 for Cloudflare → NPM).
      Wrong configuration puts all visitors in one rate-limit bucket (depth
      too low) or lets clients spoof fresh IPs (depth too high) — set it to
      the ACTUAL proxy chain, never a guess. Cloudflare is optional.
- [ ] `ts_session` cookie arrives with `Secure` (verify via devtools over HTTPS).
- [ ] Recommended proxy limits per visitor IP: 60 req/min for pages/API reads;
      10 req/min for `/api/settings/*`, `/api/session/*`, `/api/profile/*`;
      block response codes 429 with `Retry-After`.

## Environment (.env)
- [ ] `APP_BASE_URL`, `ORIGIN`, `PUBLIC_BASE_URL` and `ALLOWED_ORIGINS` all
      use the real browser-facing origin (local example:
      `http://localhost:5173` for all four with `PUBLIC_BASE_URL=` empty;
      public example: `https://torn.example.com` for all four).
- [ ] `TRUST_PROXY=true` (behind proxy; a proxy-addr subnet list such as
      `10.0.0.0/8,192.168.0.0/16` pins the exact proxy IPs) — `false` only
      for direct unproxied exposure.
- [ ] Do NOT leave a public deployment configured for localhost: Secure
      cookies, CSRF/origin checks, Web Push and per-IP rate limiting all
      depend on the origin configuration.
- [ ] No OWNER_BIND_* / OWNER_RECOVERY_TOKEN variables in the environment (legacy owner bind was removed; same-Torn-ID profile linking is the multi-device mechanism)
- [ ] `GUEST_PROFILE_RETENTION_DAYS=60` (or preferred retention)
- [ ] `API_KEY_ENCRYPTION_KEY` is unique per installation and backed up

## Identity
- [ ] New incognito browser gets a fresh `Guest …` profile with zero owner data.

## Jobs & quota
- [ ] Manual Sync / Restart Backfill are credential-gated (guests get no Torn
      API work).
- [ ] Worker maintenance ran at least once (guest/session cleanup log line).

## Health & headers
- [ ] `/api/health` returns `{status:ok}` without cookies and creates no profile.
- [ ] Security headers present: CSP, nosniff, Referrer-Policy, Permissions-Policy.

## Push notifications (Web Push)
- Generate VAPID keys once: `npx web-push generate-vapid-keys`
- Put `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in `.env`; restart api/worker.
- Public key is served to browsers (`/api/notifications/vapid-public-key`); the private key never leaves the server.
- Subscriptions live in `PushSubscription` (one row per browser, scoped to the profile; max 10 active devices per profile); the service worker is `/sw.js`.
- Push endpoints are validated at subscribe time (HTTPS, port 443, no
  loopback/private/link-local targets) — a user cannot register an endpoint
  that would make the server POST into the internal network. Note: endpoints
  are validated structurally, not DNS-resolved; a hostname that resolves to
  an internal address cannot be detected without a network request.
- Disabling a device, unsubscribing and per-device tests are all scoped to
  the caller's own profile. 404/410 from push services revoke the dead
  registration automatically.
- Push requires a secure context (HTTPS, or localhost for development).

## Backups
- [ ] `pg_dump` verified restorable. Operational backups are admin work done OUTSIDE the product UI (server shell / Unraid / Docker), never rendered in Settings:
      ```bash
      docker compose -f docker-compose.unraid.yml exec postgres pg_dump -U tornscope tornscope | gzip > tornscope-backup.sql.gz
      ```
