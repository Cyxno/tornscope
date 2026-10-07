# TornScope 2.5.3 — UI & Navigation Correctness

Release notes · previous: 2.5.2

A targeted correctness pass on the 2.5.2 navigation: one interaction rule for
every collapsible section, no link-looking affordance that does nothing, and
small keyboard/hit-area polish. No analytics changed, no database semantics,
no new upstream calls.

## Fixed

- **"Rewards & games" now navigates.** In 2.5.2 the section header looked
  exactly like the Economy/Progression/Activity hub rows but was an inert
  label — a broken-link feel. The family is now led by a light
  `/rewards-games` hub that points at Casino, Openables & rewards and Hunting
  (wayfinding only — no data duplication, no API calls).
- An active child route can no longer end up hidden behind a persisted
  collapsed section: navigation into a family always re-expands it.

## Improved

- **One hub-first rule for all families** (Economy, Progression, Activity,
  Rewards & games): the label navigates to the hub, only the chevron expands.
  The navigation model can no longer express a clickable-looking header
  without an action — pinned by test.
- Larger hit area for the sidebar expand/collapse control (helps touch use in
  the 1024–1279 icon-only rail) without changing the rail's footprint.
- Keyboard focus returns to the **More** button when the mobile section sheet
  closes, instead of dropping to the page body.

## Upgrade

Standard flow (`scripts/deploy-prod.sh`). No config changes, no database
migration, no historical repair.
