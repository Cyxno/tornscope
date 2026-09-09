# Daily Summary

The Daily Summary (v0.2 roadmap item #2) answers one question for one day:
**"What actually happened to my account?"** — with the data-confidence model
([DATA-CONFIDENCE.md](DATA-CONFIDENCE.md)) applied everywhere.

---

## Purpose and surface

- A first-class **Daily Summary** section lives on the **Today page**
  (`/today`), above the live bars: the day recap ("what happened") complements
  the live state ("what's happening"). It is deliberately not a new top-nav
  item — the nav already carries nine entries.
- The selected date is URL state: `/today?date=2026-09-08`. Empty = today.
  Previous/next-day arrows and a date picker are provided; **future dates are
  rejected** (the picker caps at today, the API returns 400).
- Endpoint: `GET /api/daily-summary?date=YYYY-MM-DD` (profile-scoped, demo-aware).

## Date / timezone semantics

- A "day" is the **calendar day in the user's configured timezone**
  (`User.timezone`, IANA, default `"UTC"`). All profiles currently default to
  UTC, so behavior matches the rest of the app until a real zone is set.
- Boundaries are resolved by `resolveDayRange` in `packages/shared/src/day.ts`:
  exact local midnight→next-midnight bounds in unix seconds, DST-safe
  (23/25-hour days produce correspondingly shorter/longer bounds), malformed
  zones fall back to UTC (mirroring the quiet-hours engine).
- The same resolved bounds are used for EVERY query in the summary — there is
  no server-UTC vs UI-local mismatch.
- "Today" is not a backend special case: the endpoint serves any date the
  same way; the only difference is the `ongoingDay` flag.

## Financial semantics — the four lenses are never merged

Reuses the canonical classifiers (`aggregateMoneySemantics`,
`classifyMoneySemantics`, `getNetworthPeriodForRange`) — Daily Summary never
reclassifies events locally.

| Lens | Meaning | Examples |
|---|---|---|
| **Cash flow** | Money that moved through the wallet | salary in; bazaar sale in; stock purchase out |
| **Economic effect** | True income/expense — value gained or lost | salary (income); gym, rehab (expenses) |
| **Conversions** | Value changing form — never income, never spending | bazaar sale (asset→cash); stock/bank (cash→asset); bank invest/withdraw (internal) |
| **Net Worth Change** | Official Torn snapshot delta — includes price moves | "a wealth movement, never a profit figure" |

Concretely: a bazaar sale raises Cash received but not True income; a stock
purchase raises Cash spent but not True expenses; both appear under
Conversions. Bank interest is economic income; gym/rehab payments are true
expenses where the existing classifier says so.

## Net worth: delta and "why did it move?"

- `start`/`end` come from official snapshots at/before the day bounds
  (`full` coverage), or the tracked portion (`partial`), or nothing (`none` →
  delta `null`, rendered "Insufficient history" — never 0).
- `drivers[]` is a lightweight, deterministic explanation layer — NOT a
  reconciliation. Snapshot category deltas (cash/banks/items/stocks/…), the
  recorded economic net, estimated consumption and estimated travel profit
  are listed as **likely contributors** with `certainty`:
  `recorded` | `estimated` | `unexplained`.
- A final `residual` driver appears only when recorded activity does not
  explain the snapshot delta beyond a material threshold. The UI says
  "likely contributors — recorded movements, not causes" and never uses
  causal wording like "caused".

## Highlights

Deterministic rules only (no LLM, no randomness), targeting 3–8 highlights on
an active day and a calm "quiet day" state otherwise:

- the two largest single cash movements above `max($50k, 20% of the day's flow)`;
- the largest conversion category;
- net-worth move (when snapshots exist);
- travel (trips + estimated profit), drug/Xanax consumption (estimated value),
  rehab (visits + cost), crimes with non-zero proceeds, combat wins (≥1),
- up to two `torn_event` account events;
- an empty list collapses to a single `quiet_day` highlight.

Each highlight is machine-readable (`kind`, canonical `label`, signed
`amount`, `occurredAt`, `tone`); the frontend composes the sentence. Same
data → same highlights, enforced by a test.

## Confidence behavior

- Every section carries a `DataConfidenceMeta` from the central derivation:
  money sections ← `money_logs`, travel ← `travel`, drugs ← `drugs`, rehab ←
  `rehab`, net worth ← `networth`.
- `overallConfidence` is the worst of the critical sections (money_logs,
  networth, drugs, travel). A missing **money** lens makes the whole summary
  `unavailable`; other critical holes degrade it to `partial` (the summary
  still exists with visible holes).
- **Today is capped**: an ongoing day can never claim end-of-day completeness
  — `overallConfidence` is at most `partial` with reason `day_in_progress`
  while the day has not ended.
- Valid zero vs unavailable follows the standard contract: a quiet day under
  proven coverage renders real `$0`s; the same day without coverage renders
  "—". Under `stale_permission` with retained history, empty days stay valid
  zeros (the retained dataset genuinely observed them) and the Stale badge
  warns that refreshing stopped. Unknown rehab cost keeps the known sum with
  `incomplete`, or `unavailable` when no visit carried a cost — never 0.

## Provenance

- Travel profit and consumption values are `estimated` (current catalog
  prices) and labeled as such — never "spend", never confirmed earnings.
- Xanax funding buckets (`confirmed_personal`, `confirmed_faction`,
  `confirmed_other`, `opening_inventory_unknown`, `unknown`) are preserved
  verbatim via the shared ledger (`services/xanaxLedger.ts`); faction-
  sponsored units have a personal cost of exactly $0, and sponsorship is only
  claimed from armory evidence, never from war context.
- Cash figures and the net-worth delta are `exact` (Torn-provided rows and
  snapshots); economic net and cash net are `derived` sums.

## Demo

The demo seed adds a deterministic "signature day" (yesterday, UTC) with
earned income, a large bazaar sale, a stock purchase, a bank deposit, a gym
expense, a rehab visit (mirrored to the money ledger like the real
normalizer does), a completed trip with purchases, two faction-sponsored
Xanax uses (armory evidence) and two account events — so the Daily Summary
has a coherent day to explain. All rows stay user-scoped `source: "demo"`;
the global item catalog is never written.

## Performance

One endpoint, one batched read: availability context (credentials + all sync
states + demo flag) plus per-domain queries bounded by the single day window
(money, drugs, consumption, rehab, travel, crimes, combat, events), the four
networth anchor queries, the shared market-price load and the xanax ledger
queries. No N+1, no per-section re-reads, no caching of date summaries.

## Developer guidance

- New summary sections must reuse canonical analytics/classifiers and take a
  `DataConfidenceMeta` from `resourceConfidence` — never compute confidence
  inline.
- Render through `formatKpiValue`/`ConfidenceBadge`; unavailable is "—",
  confirmed zero is `$0`, estimates carry the estimated label.
- Highlights/drivers are deterministic rules with documented thresholds; keep
  hedged wording on the frontend and machine `kind`s on the wire.
