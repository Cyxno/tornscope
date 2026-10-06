# TornScope 2.5.2 — Navigation & Release Alignment

Release notes · previous: 2.5.1

An information-architecture release: TornScope's analytics surface had outgrown
a navigation model that listed every route at once. This release introduces
progressive disclosure — primary destinations stay immediately visible, secondary
pages remain exactly one interaction away — plus the release-identity alignment
the 2.5.1 tag/images mismatch left pending. No URL changed, no database
migration, no new analytics domains, no new upstream API calls.

## Improved

- **Sidebar reorganized as TornScope grew** (`/` rail): Economy, Progression and
  Activity act as hub pages; Stocks, Energy/Merits/Drugs and Timeline/Logs live
  one expand away. Crimes, Combat, Faction and Travel form a Gameplay group;
  Casino, Rewards and Hunting group under Rewards & games.
- **Progressive disclosure on desktop**: collapsible families shrink the main
  nav list from 24 rows to 12 (System pages stay in the footer); the family
  containing the current page
  expands automatically, other collapsed choices persist browser-locally, and
  the hub label navigates while only the chevron toggles.
- **Mobile More menu** is a compact accordion of semantic groups (at most two
  open at a time) instead of a two-column route matrix — any route costs one
  group decision plus one tap. The bottom bar now carries Overview, Today,
  Activity and More (Timeline remains one tap inside Activity).
- **Current-section context**: an active child lights its family on desktop;
  the mobile header shows the current page next to the brand (e.g.
  "TornScope · Drugs").

## Fixed

- Clarified Xanax usage and successful-use streak semantics: the used count
  includes overdoses, the good streak counts consecutive successful uses across
  all drugs, and both populations are labeled explicitly.

## Technical

- `nav.ts` is one semantic navigation source (sections → families → routes)
  feeding rail, tab bar and sheet; every user-facing route is represented
  exactly once (test-pinned). Route semantics and `isActivePath` behavior are
  unchanged.
- Release identity alignment: 2.5.1 shipped from two different commits (tag
  c6df7b1 vs main bd03de7). 2.5.2 canonically contains both plus this cleanup —
  one version, one tag, one SHA, one image set.

## Upgrade

Standard flow (`scripts/deploy-prod.sh`). No config changes, no database
migration, no historical repair.
