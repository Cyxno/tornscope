# TornScope 2.8.1 — Overview Live-State Repair

Release notes · previous: 2.8.0

A production bug on the Overview cockpit showed bars as **Full at 100%**
while the numbers on the same card said otherwise — Energy "25 / 150 —
Full", Nerve "1 / 49 — Full", Happy and Life identical — and the travel
row could stay stale for hours. This release removes the two structural
causes; every fix is an invariant with regression tests, not a symptom
patch.

## Root cause (proven in production data flow)

1. **Snapshot freshness re-stamping** — `Overview`'s analytics-zone load
   re-saved the browser cockpit snapshot with `fetchedAtMs: Date.now()`
   while the embedded `today` payload was much older. Snapshot freshness
   was judged from that outer storage timestamp, so the cockpit looked
   "fresh" (<120s) on every mount and `/api/today` was skipped
   indefinitely: the whole live payload could age for hours.
2. **Expired boundary ⇒ fabricated Full** — on that aging payload every
   bar's `fullAt` eventually passed. Both render paths promoted an
   expired `fullAt` to "Full" (+100% fill) even though the stale
   `current` was far below `max`. A live Torn read can never produce that
   combination; a stale snapshot can, and did.

## Fixed

- **`current < max` ⇒ never Full** (one canonical derivation shared by
  Overview and Today, `barFullDisplay`): a cached `regenState: "full"` is
  only believed when `current >= max` agrees; an expired full-at boundary
  renders as "stale — revalidating" (Overview: no timer), never as Full.
- **Percent derived from `current/max` at render time** on both pages —
  a cached `percent` field (e.g. 100 on a 25/150 bar) is never trusted.
- **Atomic snapshot freshness**: the cockpit snapshot is fresh or stale
  by the today payload's own `fetchedAt`, never the outer storage
  timestamp. Re-saving OCS/travel-duration data around an old payload no
  longer refreshes live-status freshness.
- **Corrupt snapshot invalidation**: snapshots whose payload stamp is
  unreadable or which lack the bars subset are rejected AND removed so
  the next load heals (extends the 2.6.2 future-stamp guard).

## Overview == Today

Both pages now derive bar state from the same shared helper; the Today
page's private `barState` full-decision logic was deleted. Identical
payload + identical server clock ⇒ identical rendering, verified by
regression tests.

## Travel freshness

No dedicated travel change was needed: travel staleness was a symptom of
the same skipped revalidation (the payload never aged because the
snapshot was perpetually re-stamped). Travel keeps its resource-specific
freshness (`travel.syncedAt`, landing fast-path), which now actually
receives fresh payloads again.

## Tests

New suite `apps/web/tests/live-state-invariants.test.ts`: the production
cases 25/150, 1/49, 4911/5025, 170/1732, stacked 400/150; cached-percent
distrust; mixed snapshot (fresh storage stamp, old payload) revalidates;
corrupt snapshots invalidate; Overview never re-stamps; Overview/Today
delegate to one derivation. Full monorepo suite green.
