# Reverse proxy / HTTPS deployment

TornScope works on `http://localhost:5173` with zero configuration. The
moment it is reached any other way — a LAN hostname/IP, a reverse proxy
(Nginx Proxy Manager, Caddy, Traefik, …) or a public domain — the
environment MUST match the address users actually open in their browser.
Otherwise, in the best case, pages render but sessions and push break
silently; in the worst case, session cookies lose their `Secure` flag,
CSRF/origin protection rejects every mutation, Web Push / service workers
stop working (browsers only expose them in secure contexts), and rate
limiting buckets every visitor onto one shared IP.

## Origin configuration

**Local development** (works out of the box, shown for reference):

```bash
APP_BASE_URL=http://localhost:5173
PUBLIC_BASE_URL=
ALLOWED_ORIGINS=http://localhost:5173
ORIGIN=http://localhost:5173
```

**Public deployment** on `https://torn.example.com` (replace with YOUR
domain — TornScope never assumes one):

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

## Reverse proxies, protocol and client IP

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
  too high an attacker can spoof a fresh IP per request. The trusted proxy
  depth/chain must reflect the actual deployment — never guess it.

- **`TRUST_PROXY`** (API) — controls whether Fastify honors `X-Forwarded-*`
  at all. `true` (default) trusts the web app's own proxy hop, `false` is
  only for direct unproxied exposure, and a proxy-addr subnet list (e.g.
  `10.0.0.0/8,192.168.0.0/16` or the `loopback` preset) pins the exact
  proxy IPs. Behind Cloudflare or any multi-proxy setup, configure the value
  to match the actual chain rather than leaving the default guessed —
  Cloudflare is NOT mandatory; without it a single proxy is enough.

Incorrect deployment-origin configuration can break: **Secure session
cookies**, **CSRF/origin protection**, **Web Push / Service Workers**
(browsers require a secure context), **browser secure-context behavior**,
and **client-IP rate limiting**.

## Web Push on non-local deployments

Web Push requires a secure context (HTTPS). Configure VAPID keys
(`npx web-push generate-vapid-keys`) and set `VAPID_SUBJECT` to your
`https://` origin or a `mailto:` address on a real domain — Apple's push
service rejects reserved-TLD subjects such as `*.local`.
