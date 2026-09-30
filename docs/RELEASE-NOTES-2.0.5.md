# TornScope 2.0.5 — Cockpit Heads-up Update

**Overview = "What is happening NOW, and what do I need to factor in soon?"**
2.0.5 adds a small, reliable anticipation layer to the cockpit: urgency-based
active-state ordering, configurable heads-up cues for the timers that matter,
and a context-aware travel/OC timing conflict warning. No notification
machine — cues are conservative, deduped and personally configurable.

## Urgency-based Active States

The Active States block no longer renders in fixed component order. A pure
urgency model sorts every state:

1. **Hard state / location** — flying, returning, landed, abroad, hospital, jail
2. **Actionable now** — bank ready to collect, OC ready, cooldown ready
3. **Finishing soon** — anything within the hour
4. **Later** — remaining timed states

Within a tier, states sort by time remaining (soonest first). Cooldown tiles
keep their fixed strip order; the canonical Home row closes the block.

## Heads-up cues (configurable)

A central, deterministic derivation turns the live timers into threshold
cues with one-shot event keys — rerenders, reloads and worker restarts can
never duplicate one:

| Timer | Default pre-alert | At event | Push |
|---|---|---|---|
| Travel landing | T-2 min (options 0/1/2/5) | ✓ | configurable (`travel_landing_soon`, threshold follows) |
| Drug cooldown | T-2 min | ✓ | existing type (at-ready) |
| Booster | at ready (pre optional) | ✓ | existing type |
| Medical | at ready (pre optional) | ✓ | existing type |
| Organized crime | T-5 min (0/2/5/10) | ✓ | existing `oc_ready_soon` unchanged |
| Bank maturity | T-10 min (0/5/10/30) | ✓ | existing `bank_matured` |
| Education | visual only (sorts higher inside an hour) | — | — |

Presented as a compact banner above the cockpit cues: `Soon · Travel · UAE ·
1m 52s`, `Now · Bank · Ready to collect`. Thresholds are profile-level
(Settings → Notifications → Heads-up thresholds; stored in the existing
typed `typeConfig` — no migration).

## This device

Banner visibility and the local sound are browser-local (Overview settings):
- **Heads-up banners** — on by default; turning them off leaves push untouched.
- **Sound** — OFF by default, explicit opt-in, one short ping per NEW cue,
  only after the page has been interacted with (no autoplay), never looping.

## Travel/OC timing conflict

While a flight is actually in progress and the destination's duration is
known from the player's OWN recorded history (median of completed trips —
exact data, stable game mechanic), the cockpit warns when the round trip
would run past the OC's ready time:

> Heads up · timing conflict
> OC · Break-in in 5h 02m · round trip ≈ 14h 25m
> You may not be back in time. Flying to UAE.

required time = remaining flight + 10 min purchase buffer + return flight +
15 min safety buffer (centralized constants; conflict is strictly
`required > OC ready window`). No intent guessing at home; unknown
destination duration → no warning. Dashboard-only — never a push.

## Stale data safety

Stale payloads (flag or age > 30 min) suppress every actionable cue and the
conflict warning — "Landing in 2 minutes" is never claimed from old data.

## Overview / Today roles

- **Overview**: "What is happening now?" — the canonical live page.
- **Today**: "What happened today?" — activity, money, day story.
- The cockpit's "Full live status →" link is now "Today's activity →".

## Technical

- Zero migrations (thresholds live in the existing typed `typeConfig` JSON).
- Zero new Torn API calls (durations derive from stored `TravelEvent` rows;
  additive `travelDurations` on `/api/travel/summary`).
- ONE shared dashboard ticker drives bars, tiles, states, Command Center and
  heads-up — no per-tile intervals.
- Push pre-alert reuses ingest (quiet hours, dedupe ledger, activation
  boundary); the engine wakes at the configured pre-alert moment.
