# Torn API v2 — verified schema notes

Source of truth: the official OpenAPI specification at `https://www.torn.com/swagger/openapi.json`
(spec `Torn API` version **6.13.1**, OpenAPI 3.1, retrieved 2026-09-04). These notes record the
facts this project relies on so future changes can be diffed against the live spec.

## General

- Base URL: `https://api.torn.com/v2`
- Auth: every request carries the key. We use the `Authorization: ApiKey <key>` header so the key
  never appears in URLs, logs or pagination links.
- Error envelope: `{ "error": { "code": <int>, "error": "<message>" } }` (documented codes 0–30;
  e.g. 2 = incorrect key, 5 = too many requests, 8 = IP block, 16 = access level too low,
  17 = backend error retryable, 18 = key paused).
- Rate limits: ~100 requests/min per user across keys, 1000/min per IP; ~29s response cache.
- Pagination: responses carry `_metadata.links.next/prev` (absolute URLs). Our client strips any
  embedded `key` param and re-issues links through the authenticated client.

## Endpoints used

| Endpoint | Access | Notes |
| --- | --- | --- |
| `GET /key/info` | public | `info.user.{id,faction_id,company_id}`, `info.access.{level,type,log.available}` |
| `GET /user/basic` | public | response wrapper key is `profile` (per spec) |
| `GET /user/profile` | minimal | `profile.{id,name,level,rank,title,age,faction_id,property,status,gender,life,...}` |
| `GET /user/bars` | **minimal** | `bars.{energy,nerve,happy,life}` each `{current,maximum,increment,interval,tick_time,full_time}` — `full_time` is a **unix timestamp** (0 when full/not regenerating); never derive regen ourselves when it is 0 |
| `GET /user/cooldowns` | **minimal** | `cooldowns.{drug,medical,booster}` are **seconds remaining** (0 = ready); ready-at must be derived server-side and sent as an absolute timestamp |
| `GET /user/education` | **minimal** | `education.{complete[],current}`; `current = {id, until}` — `until` documented as int32; treat as unix timestamp, defensively normalize ms/seconds-remaining shapes |
| `GET /torn/education` | public | catalog: `education[].{id,name,courses[].{id,code,name,duration,...}}` — resolves current course id → name/category |
| `GET /user/travel` | **minimal** | `travel.{destination(CountryEnum),method,departed_at,arrival_at,time_left}`; while flying home `destination` reads `"Torn"` — direction derives from `profile.status.state == "Traveling"` + destination |
| `GET /user/status` (selection) | — | no standalone v2 path; status comes from `profile.status = {description,details,state,until,color}`; `state ∈ {Abroad,Awoken,Dormant,Fallen,Federal,Hospital,Jail,Okay,Traveling}`; `until` = release/landing unix timestamp |
| `GET /user/networth` | limited (marked *Unstable*) | full breakdown: `money{wallet,vault,city_bank,cayman_bank,piggy_bank,bookie,loans,unpaid_fees,pending}`, `items{inventory,display_case,bazaar,trades,item_market,auction_house,enlisted_cars}`, `assets{property,stock_market,company}`, `points`, `total`, `timestamp` |
| `GET /user/money` | limited | current positions: `money.{points,wallet,company,vault,cayman_bank,city_bank,faction,daily_networth}`; `city_bank = {amount,profit,duration(days),interest_rate,until,invested_at}` or `null` |
| `GET /user/personalstats?cat=all` | public | flat map stat name → number |
| `GET /user/log` | **full** | params: `cat` (category id), `log` (ids), `from`, `to`, `limit` (default 20, max 100); response `{log: [...], _metadata}`; entry: `{id, timestamp, details:{id,title,category}, data:{}, params:{}}` — `data`/`params` are **dynamic key-value objects** (NOT part of the contract) |
| `GET /user/events` | limited | `{events: [{id,timestamp,event}], _metadata}`; `event` is HTML; no `sort` param |
| `GET /faction/basic` | public | `{basic: {id,name,tag,respect,days_old,capacity,members,leader_id,co_leader_id,best_chain}}` |
| `GET /torn/items?cat=All` | public | `{items: [{id,name,type,is_tradable,value:{market_price,...},...}]}` |
| `GET /torn/logcategories` | public | `{logcategories: [{id,title}]}` |
| `GET /torn/{logCategoryId}/logtypes` | public | `{logtypes: [{id,title,...}]}` |

`CountryEnum`: Mexico, Hawaii, South Africa, Japan, China, Argentina, Switzerland, Canada,
United Kingdom, UAE, Cayman Islands, Torn.

## Today (live status) notes

- Request pattern per `/api/today` cache window (default 30s): `user/profile`,
  `user/bars`, `user/cooldowns`, `user/education`, `user/travel`, `user/money`
  (money is skipped below Limited access; the others below Minimal). At most
  ~120 requests/hour at a 30s window while the tab is open — well within limits.
- The backend returns **absolute unix timestamps** (bars `fullAt`, cooldown
  `endsAt`, travel `landsAt`, education `completesAt`, bank `maturesAt`,
  hospital/jail `releasedAt`); the browser renders countdowns locally, so no
  per-second traffic reaches Torn or the backend.
- Cooldowns are the only live input that is *not* an absolute timestamp in the
  Torn API — `endsAt = serverNow + secondsRemaining` is computed once per fetch
  and re-anchored on every poll.
- Live state is **not persisted** per poll. Travel flights, bank movements and
  education completions are already represented by Torn's own logs, which the
  worker records as historical truth; duplicating them from live polling would
  create noise. Status-transition detection helpers (with stable dedup keys)
  live in `packages/shared/src/today.ts` for future use.

## Design consequences in this codebase

1. Log `data` payloads are undocumented → `packages/database/src/normalizers/*` extracts values
   defensively from candidate keys, keeps raw payloads in JSONB, and never invents values.
2. Log routing uses each entry's own `details.category` title matched against
   `LOG_CATEGORY_ROUTES` keywords; category ids are resolved at runtime via `/torn/logcategories`.
3. Travel resale profits use `/torn/items` market prices and are always labeled
   `provenance: "estimated"`.
