# Data Confidence & Coverage

How TornScope v0.2 answers the question every number on every page implicitly
asks: **how complete and how trustworthy is this data?**

This is the foundation for roadmap item #1 (v0.2) and for everything that
builds on it — most directly the Daily Summary.

---

## The problem

Before v0.2, several responses could not distinguish between:

- a value that is genuinely `0`
- a value that could not be retrieved
- history that exists but is no longer refreshing
- history that is still being imported
- a range that was never covered

A `0` must mean *"we have enough trustworthy information to conclude the value
is zero"* — never *"we could not retrieve the value."*

## The three layers

| Layer | Question | Where |
|---|---|---|
| **DataConfidence** (dataset level) | Can I trust coverage of this range at all? | `packages/shared/src/confidence.ts` |
| **Provenance** (value level) | How was this number produced? | `packages/shared/src/provenance.ts` |
| **KpiAvailability** (value level) | May this specific figure render as-is? | `contracts.ts`, derived from confidence |

### Confidence states (`DataConfidence`)

| State | Meaning |
|---|---|
| `complete` | Required source data was available, expected coverage is satisfied for the requested range, and no known permission or sync gap invalidates the result. |
| `partial` | Useful data exists, but known coverage gaps, incomplete history, bounded sync windows or an unfinished backfill prevent claiming completeness. |
| `stale_permission` | History exists and is retained, but the current API key can no longer refresh it. Never rendered as live data, never deleted. |
| `unavailable` | No meaningful value can be produced for this context. **Never rendered as a numeric zero.** |

Completeness is claimed only when it is provable: a clean backward walk
(`stopReason` = `history_boundary_reached` / `source_exhausted`) or a snapshot
resource with a successful sync, a refreshed-enough tail, and a requested
range inside the covered window. Anything less is `partial`.

### Provenance (unchanged, where useful)

- `exact` — provided verbatim by the Torn API (e.g. a money event amount)
- `derived` — computed from exact data without estimation
- `estimated` — relies on an internal estimate (e.g. current-catalog prices
  applied to historical item movements)

Provenance describes *values*; confidence describes *datasets*. A value can be
`estimated` inside a `complete` dataset (travel profit), or `exact` inside a
`stale_permission` one (old money events).

### Machine-readable reasons (`ConfidenceReason`)

| Reason | Meaning |
|---|---|
| `missing_permission` | Permission missing, nothing stored — nothing to show. |
| `historical_permission_lost` | History retained, current key lost the permission. |
| `never_synced` | Permission fine, resource never completed a sync. |
| `backfill_in_progress` | A walk is running; values may still change. |
| `sync_incomplete` | Coverage is bounded (page cap, stalled cursor, walk pending). |
| `sync_error` | Last attempt failed; retained history is still shown. |
| `range_before_coverage` | The requested range starts before TornScope began collecting. |
| `source_unavailable` | The source answered but holds no data for this context. |

Reasons are codes, never prose. The UI maps them to copy in
`apps/web/src/lib/confidence.ts` (`CONFIDENCE_REASON_COPY`); a grep-level test
fails if a code ships without copy. `estimate_only` deliberately does not
exist as a confidence reason — estimation is provenance, not confidence.

## Response metadata

```jsonc
// DataConfidenceMeta — one per dataset/card, never per numeric field
{
  "confidence": "partial",
  "reason": "range_before_coverage",
  "lastRefreshedAt": 1767000000,
  "coverage": { "from": 1761000000, "to": 1767000000, "hasKnownGaps": false }
}
```

- Boundaries are exposed only when the system truly knows them. `coverage.from`
  for walk resources is derived from `stopReason` + `sourceEarliestAt`
  (collection window, not "oldest row" — the Sync Status page shows the stored
  row bounds separately). `hasKnownGaps` is `true` only for provable gaps.
  The derivation never invents gap ranges.
- `lastRefreshedAt` is the backing resource's `lastSuccessAt` from SyncState —
  never a generic row `updatedAt`.
- Currently carried by: `/api/sync/health` (per resource), `/api/dashboard`
  (`cashFlow`, `drugs`, `travelProfit`, `rehab`, `networth`), `/api/economy`
  (`cashFlow`, `consumption`, `networth`, `travel`).

## Central derivation

`deriveDataConfidence(facts, range, now)` in `packages/shared/src/confidence.ts`
is a **pure function**: same inputs, same output, no hidden lookups, trivially
testable, reusable by future endpoints (including Daily Summary).

The API-side counterpart `apps/api/src/services/confidence.ts`:

- `loadAvailabilityContext(userId)` loads credentials + **all** SyncState rows +
  demo flag in **one batched read** (shared with the existing availability
  blocks — endpoints never query per card).
- `resourceConfidence(ctx, resource, { range, ... })` builds the facts and
  calls the pure derivation.
- Demo profiles are overridden once, here: demo data is a complete synthetic
  snapshot, so it reports `complete`/`partial` on its own merits — never
  `stale_permission` (there is no key to lose).

Controllers must not hand-roll `if capability && lastSuccess ...`. Ask the
service for the resource(s) a card renders and use the metadata. Value-level
availability comes from `kpiAvailabilityFromConfidence(meta)`, optionally
combined with value-level evidence via `worstKpiAvailability` (e.g.
unparseable rows ⇒ `incomplete`). Multi-resource sections use
`worstConfidence([...])`.

### Valid zero vs unavailable

| Situation | Confidence | Value | Renders as |
|---|---|---|---|
| Clean full walk, zero money rows in range | `complete` | `0` | `$0` (confirmed) |
| Range extends before collection started | `partial` / `range_before_coverage` | number | value + "Partial" badge |
| Backfill running, rows exist | `partial` / `backfill_in_progress` | number | value + "Importing" |
| Backfill running, nothing yet | `unavailable` / `backfill_in_progress` | `null` | "Importing" |
| Key lost permission, history exists | `stale_permission` | number | value + "Stale" badge |
| Key lost permission, nothing stored | `unavailable` / `missing_permission` | `null` | "—" |
| Never synced | `unavailable` / `never_synced` | `null` | "—" |

## Operational status ≠ data confidence

Sync Status keeps two separate vocabularies, side by side but never merged:

- **Operational phase** (`queued / running / backfilling / caught_up / partial /
  failed / permission_required`) — *is the worker functioning?*
- **Confidence** (`complete / partial / stale_permission / unavailable`) —
  *how trustworthy is the data?*

A resource can be `permission_required` (operationally) with `stale_permission`
data shown, or `failed` (a broken job) with retained `partial` history —
those are different problems with different fixes.

## Capability loss behavior

When a key loses access (detected pre-sync by the capability gates, or at
runtime by Torn error code 16 — the runner then records `capability_denied`,
not `failed`):

1. previously collected data is kept — nothing is reset or deleted;
2. the resource parks at `CAPABILITY_RECHECK_SECONDS` (6 h) instead of hot-retrying;
3. confidence becomes `stale_permission` / `historical_permission_lost`;
4. the UI keeps rendering the retained history with a Stale badge;
5. new ranges without data render as unavailable — never as zeros.
   Replacing the key with a capable one re-enables the resource immediately.

## Frontend contract

- `ConfidenceBadge.svelte` — subtle pill; renders **nothing** for `complete`
  (trust needs no badge), small warning-tinted `Partial` / `Stale`, muted
  `— Unavailable`. Tooltip text comes from `confidenceTitle()`; the visible
  label is the accessible text (title tooltips match the ProvenanceBadge
  convention).
- `Stat.svelte` accepts a `confidence` prop for strip cells.
- `formatKpiValue` remains the value-level renderer: `$0` only for confirmed
  zeros, otherwise `Importing` / `Incomplete` / `—`.
- All confidence strings live in `apps/web/src/lib/confidence.ts` — pages must
  not hand-write them, and raw reason codes must never be displayed.

## Developer guidance for new endpoints

1. Load one context: `const ctx = await loadAvailabilityContext(userId)`.
2. For each dataset a card renders:
   `const meta = resourceConfidence(ctx, "money_logs", { range })`.
3. Derive value availability: `kpiAvailabilityFromConfidence(meta)` combined
   with any value-level evidence (`worstKpiAvailability`).
4. Ship `meta` in the response under a compact `confidence` block; render
   badges/tooltips from it client-side.
5. Return `null` (not `0`) unless the dataset confidence supports a confirmed
   zero.
6. Never persist derived confidence — it is always computable from current
   system state. Persisted confidence goes stale; derived confidence cannot.

## History

- Introduced in v0.2.0 (roadmap item #1) — derivation, sync-health integration,
  Overview + Economy integration, capability-loss runtime detection.

---

## Value coverage & valuation semantics (2.5.0)

With the activity/rewards layer (2.4.0+) the confidence model extends from
*datasets* to *value components*. Where the activity surfaces show money,
they distinguish three valuation classes — provenance for values, exactly
as above:

| Class | Meaning | Example |
|---|---|---|
| **exact** | Verbatim from a Torn log payload or the signed ledger amount. | Casino bet/won, hunting cost/income, bounty cost/reward, mission cash. |
| **estimated** | Exact quantities valued with CURRENT catalog market prices; always labeled "estimated using current market prices". | Openable reward/input items. |
| **unpriced** | A reward exists but no defensible monetary valuation does. Shown, never converted to zero. | Mission credits, racing points, hunting skill, points-only pack rewards. |

An exact zero (e.g. a credits-only mission completion with `money: 0`) is a
known zero and stays zero — distinct from an unknown, per the valid-zero
rule above.

Known limitations, disclosed rather than hidden:

- **No historical prices.** Only the current catalog price exists
  (`TornItemCatalog`); past item values are present-day estimates, never
  presented as historical profit.
- **Legacy casino money logs** (old-format rows with only a signed amount)
  normalize as `casino-legacy` with `game = null` — the game stays unknown.
- **Casino ledger gaps are structural** (slots/keno/blackjack/high-low/
  bookie cash never appears in Torn money logs; lottery/wheel placements
  have no settlement log). Differences are disclosed by the reconciliation
  — never patched.
- **Hunting/missions/racing/bounties/education cash is semantic-only**:
  Torn emits no money logs for it, so the activity surfaces report it once
  and the money ledger does not contain it (no double counting, and no
  silent absence — the `/activity` page labels each domain
  `ledger + semantic` or `semantic-only`).
- **Education** claims only the logged start (cost, course, duration); no
  completion or ROI semantics are fabricated.

Coverage accounting (recognized / normalized / analytics-used at family
and event level) lives in `docs/VALUE-COVERAGE.md` and is measurable with
`audit:activities`.
