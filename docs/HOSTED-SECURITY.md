# Hosted Security

How a publicly reachable TornScope deployment defends itself and its users.
This is the security reference for operators and contributors; the
deployment recipe lives in [HOSTED-DEPLOYMENT.md](HOSTED-DEPLOYMENT.md).

## 1. Threat model (concise)

**Actors.** Anonymous visitors (every browser gets a lazy profile),
legitimate users, malicious authenticated profiles, automated bots
(no cookies / no Origin), compromised browser sessions, hostile push-endpoint
input, operator mistakes, runaway worker jobs.

**Assets.** Torn API keys (encrypted at rest), session identifiers, private
analytics, push subscriptions, encryption secrets (AES key, VAPID private
key), historical Torn data, DB/Redis availability, worker capacity, logs.

**Trust boundaries.** Browser → web (SvelteKit same-origin proxy) → API
(Fastify, loopback) → Postgres; API/worker → Redis (internal network);
worker → Torn API (outbound, key-scoped); worker/API → push providers
(outbound, SSRF-guarded); reverse proxy → web; container → host.

**Highest-risk paths & answers.**
| Path | Mitigation |
|---|---|
| Bot mints anonymous profiles → table growth | Lazy creation throttled per IP (20/h default, env-tunable), bootstrap coalescing (425), daily bounded cleanup of empty guests (60d) |
| Flood expensive analytics | Hard row caps per query, bounded pagination, global 300/min/IP + per-route buckets, `Cache-Control: private, no-store` |
| Cross-user reads/writes | Identity only from the session (`currentUser`); every query userId-scoped; no route accepts a userId for data selection (audited) |
| CSRF | `SameSite=Lax` cookie + same-origin enforcement on every mutation + SvelteKit `checkOrigin`; Origin-less clients (curl) are outside the browser CSRF model by design |
| Push endpoint abuse | Structural URL validation + DNS public-address check at subscribe; re-validation before every send; per-IP subscribe limiter; 10-device cap; 404/410 revoke |
| Key theft | AES-256-GCM at rest; plaintext transient only; pino redact lists; sanitized pagination/logging; last-4 preview only |
| Torn hammering via validate | `key-save` bucket 10/10min/IP shared by validate+save |
| Session fixation/overrun | Opaque 256-bit tokens, SHA-256 stored, rotation on rebind, absolute 365d + idle 90d expiry, per-profile session cap (default 10) |
| Demo abuse | Demo profile is mutation-proof; worker never evaluates demo; demo-view toggle is per-session rate-limited; synthetic ledger never pushes |

## 2. Request boundary model

- **Body limit:** 256 KiB globally; oversized → 413 before route logic.
- **Validation:** zod schemas on every body/query; free-text filters
  (category/search ≤100, drugs CSV ≤200, ids ≤64) bounded before Prisma.
- **Ranges:** presets enum-locked; custom epochs bounded to ≤2100; `from>to`
  resolves empty; pagination `limit` ≤200 with keyset cursors.
- **Errors:** stable machine codes; 5xx = generic message + `requestId` —
  never stacks, SQL, paths, or upstream bodies. Every response carries
  `x-request-id` (echoed through the web proxy) and `cache-control:
  private, no-store` on `/api/*`.
- **Rate limits** (all 429 + `Retry-After`, code `rate_limited`):

| Class | Limit | Key |
|---|---|---|
| Global fallback | 300/min | IP |
| Key validate/save, delete, profile link, sign-out-others | 10/10min | IP |
| Sync actions (run/retry/retry-failed/backfill) | 20/10min | profile |
| Push subscribe | 20/10min | IP |
| Notification test | 5/min | profile |
| Profile delete | 5/60min | IP |
| Demo-view toggle | 20/10min | profile |
| Notification writes (unsubscribe/device/preferences) | 30/10min | profile |
| Anonymous profile creation | 20/h | IP |
| Heavy analytics GETs | global fallback + row caps | IP |

Limiters are in-process (single-node V1): they reset on API restart and do
not span replicas — documented, accepted for the beta; per-route windows are
small enough that restart-timed bursts stay bounded. Scale-out would move
`checkRateLimit` + `@fastify/rate-limit` to the Redis store.

## 3. Session & profile model

- Token: 256-bit random, `HttpOnly; SameSite=Lax; Path=/; Secure(when HTTPS)`
  cookie (`ts_session`), only a SHA-256 hash stored server-side.
- Expiry: absolute 365d + idle 90d; expired sessions revoke in place.
- Rotation: token re-minted whenever a session is rebound to another profile
  (identity-conflict new profile, profile link).
- Per-profile cap: `HOSTED_MAX_SESSIONS_PER_PROFILE` (default 10); creating
  a session revokes the stalest (by last-seen) beyond the cap — recent
  devices survive, farms don't.
- No self-serve sign-out route is needed to bound lifetime (expiry + caps +
  sign-out-others exist); the cookie clears on profile delete.
- Anonymous profile creation is lazy, per-IP throttled, parallel-coalesced,
  and guests without history are cleaned up daily (bounded 200/run).

## 4. API keys & secrets

- Torn keys: AES-256-GCM with `API_KEY_ENCRYPTION_KEY`; decrypted only in
  process for the request/sync at hand; never logged (pino redact lists
  cover `apiKey/api_key/key/authorization`); UI shows a last-4 preview.
- VAPID private key never leaves the server; only the public key is served.
- Redis URLs are logged only with credentials masked. No `req.body` logging
  exists anywhere; access logs strip query strings (push endpoints never
  enter logs).
- `role` defaults to `user` at the schema level — a forgotten role on
  `user.create` fails safe (migration `20260911200000`).

## 5. SSRF

Push endpoints are the only user-supplied URLs that the server fetches.
They are validated structurally (HTTPS, port 443, no credentials, private
literal IPs, internal hostnames) at subscribe AND before every send, plus a
DNS-resolution check at subscribe (`assertPublicEndpoint`). DNS-rebinding
residual risk is documented at `push-ssrf.ts`: validation and the actual
POST resolve the host independently, so the check is best-effort; the
push-provider allowlist reality (FCM/Mozilla/Apple endpoints) and
loopback-only API exposure make exploitation impractical, and container
egress rules are the complementary control. No other endpoint fetches
client-supplied URLs. There is no open-redirect surface (no returnTo
flows); notification click targets are payload-local paths set by the
server.

## 6. Demo isolation

The demo profile accepts no mutations (global guard), never appears in
link/credential flows, is skipped by the notification worker and sync
scheduler, and its seed data is synthetic (`isDemo=true`). The demo-view
toggle acts only on the session's own real profile and is rate-limited.
Demo cannot trigger real pushes, enqueue Torn calls, or touch global state.

## 7. Identity & enumeration

Errors never confirm Torn IDs or profile existence beyond what key
possession already proves: `profile_exists`/`identity_conflict` require a
live-validated key for that identity; wrong-key errors are generic.
Profile ids are internal cuids, never echoed in public errors.

## 8. Caching & the browser

Every `/api/*` response is `private, no-store` at the API and the web proxy
defaults to `no-store` — one user's analytics can never be served from a
shared cache to another. The service worker has no fetch handler (no API
caching); the app stores no tokens/keys in localStorage/sessionStorage
(session lives in the HttpOnly cookie only). Cloudflare guidance: do not
cache `/api/*` (see HOSTED-DEPLOYMENT.md).

## 9. Headers

API (helmet): nosniff, frame protection, `Referrer-Policy: no-referrer`,
HSTS behind TLS termination. Web: strict CSP (`default-src self`,
`script-src self` — no unsafe-eval/inline; `style-src 'unsafe-inline'` is
required by the chart renderer and documented), `frame-ancestors 'self'`
(clickjacking), nosniff, Permissions-Policy lockdown, `Referrer-Policy:
strict-origin-when-cross-origin`. `x-tornscope-build` exposes the deployed
SHA deliberately (support/build-drift correlation; no route-level secrets).

## 10. Runtime & dependencies

App containers (api/web/worker) run non-root with `no-new-privileges`,
`cap_drop: ALL`, read-only rootfs and a `/tmp` tmpfs (Prisma engines).
Postgres/Redis/migrate keep official-image expectations and are internal
(Redis unpublished; Postgres loopback-only in production). Images are
multi-stage node:22-alpine with `--ignore-scripts` installs; `.env*` never
enters build context. Dependency audit: one HIGH (`deepmerge-ts` stack
exhaustion via the Prisma CLI chain) — it executes only in the migrate
container against trusted local migrations; upgrade rides the next Prisma
release, no blind major bumps.

## 11. Operator privacy boundary

Operational visibility is aggregates only: rate-limit engagements (bucket
name), notification tick counters, maintenance counts, sync health states.
No private analytics browsing, no API-key viewing, no notification payload
inspection. Logs carry internal profile ids, resource names, statuses and
error kinds — not Torn event bodies.

## 12. Incident basics

1. Rotate `API_KEY_ENCRYPTION_KEY` only with a re-encryption plan (keys are
   unreadable otherwise); rotate VAPID by regenerating and re-subscribing
   devices.
2. Revoke suspect sessions: `sign-out-others` per profile; site-wide via DB
   (`UserSession` revoke) + restart to clear limiter state.
3. Abuse: tighten `HOSTED_*` env limits (no redeploy of code needed, just
   container recreate); the global per-IP limit caps request floods.
4. Suspected key leak in logs: pino redaction covers the known paths; treat
   affected Torn keys as compromised and have users re-link.
