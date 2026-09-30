# TornScope 2.0.6 — Travel Freshness Hotfix

**Kernregel: critical live state must have critical live freshness.** De
cockpit's travel-status is vanaf 2.0.6 resource-specifiek vers: een mislukte
refresh van een willekeurige andere sectie kan travel niet meer op
"Travel data stale" zetten, en de landing-boundary wordt binnen enkele
seconden bevestigd in plaats van na 60–90 seconden ambiguïteit.

## Root cause (audit)

`GET /api/today` is stale-while-revalidate: is de live Torn-fetch mislukt,
dan wordt de persisteerde last-known copy geleverd met een **payload-brede**
`stale: true` (zodra de copy ouder is dan het 30s-cachevenster). De Overview
haalt today één keer per mount op (geen polling) — die ene stale respons bleef
daardoor het hele beeld bepalen. De 2.0.4/2.0.5-derivatie mapte die globale
flag rechtstreeks op travel, terwijl:

- een future `landsAt` een door Torn bevestigd feit is dat op een wat oudere
  payload gewoon geldig blijft (vliegen);
- de landing-boundary (landsAt gepasseerd, nog geen bevestiging) juist het
  moment is waarop de gebruiker een duidelijk antwoord nodig heeft.

**Latency vóór de fix**: Torn → live today-fetch alleen bij paginaload (30s
TTL) → bij falen persisted copy (`stale: true`) → Overview rendert die één
keer → geen retry → ambiguity tot de volgende handmatige reload (60–90s+,
soms het hele bezoek).

## After

- **Resource-specific freshness**: travel is vers als (a) de served payload
  live is, óf (b) de travel-resource zelf recent door de worker gesynced is
  (`travel.syncedAt`, nieuw additief veld uit de bestaande SyncState-boekhoud)
  . Money/faction/education stale + travel fresh → travel blijft gewoon
  staan.
- **Landing fast-path (worker)**: zolang de persisteerde live-status een
  vlucht in het landing-window houdt, trekt de scheduler de travel-sync elke
  tick naar voren (1 extra `/user/travel` sync per minuut per vliegende
  gebruiker, gebonden aan het landing-window) — de opgeslagen travel-status
  bevestigt dus direct na de boundary.
- **Client landing fast-path (Overview)**: binnen T-5 minuten refresh de
  cockpit live status om 30s (T-1m: 15s); na de boundary blijft die cadence
  aan tot de staat bevestigd is. Elke refetch = één rate-limited live
  today-fetch; buiten het window wordt niks gepolld.
- **Transition state**: landsAt gepasseerd zonder bevestiging → `Landing…`
  (grace 5 min). Daarna pas — eerlijk — `Travel data stale · Xh since landing`.

## UX-states (freshness A–D)

- **FRESH**: `Flying to X · 21m`, `Home`, `Abroad · X`
- **TRANSITIONING**: `Landing…` (timer op 0, bevestiging onderweg)
- **STALE**: `Travel data stale · Xh since landing` (alleen na grace)
- **UNAVAILABLE**: `Travel status unavailable — <permissie>`

## Heads-up impact

De travel T-2m cue, de at-landing cue en de travel/OC conflict-warning zijn
nu afhankelijk van **travel-specifieke** staleness: een globale payload-flag
supprest ze niet meer (CASE H), echte travel-staleness wel (CASE I).

## Torn API impact

| Situatie | vóór | na |
|---|---|---|
| Home/abroad, geen vlucht | travel-sync 6/uur | ongewijzigd |
| Vlucht ruim onderweg | 6/uur | ongewijzigd |
| Landing-window (T-15m → +10m) | 6/uur | ±60/uur extra `/user/travel` sync (1/tick) |
| Cockpit open tijdens landing | handmatige reload (onbetrouwbaar) | client 30s/15s live today-fetch ≈ 2–4×6 calls/min gedurende ±7 min, binnen de ~100/min budget |

Bounded: het fast-path geldt alleen tijdens het landing-window en stopt
zodra de state bevestigd is. Geen nieuwe sync-jobs, geen dubbele jobs.

## Observability

`travel.syncedAt` reist mee in de today-payload (geen secrets) en System
Health toonde de travel-freshness al als resource-rij (bestaand model).
