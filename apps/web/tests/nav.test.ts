import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALL_NAV_ITEMS,
  MOBILE_SHEET_GROUPS,
  MOBILE_TABS,
  NAV_FAMILIES,
  NAV_SECTIONS,
  PERSISTENT_ITEMS,
  activeItemForPath,
  familyForPath,
  isActivePath,
} from "../src/lib/nav";

/**
 * Navigation IA contracts (2.5.2): ONE semantic nav model feeds the desktop
 * rail, the mobile tab bar and the mobile More sheet. Progressive disclosure
 * may change presentation, never semantics:
 *   - every user-facing route stays represented exactly once;
 *   - active children activate their family (parent groups light up);
 *   - deep links keep working (URLs never changed);
 *   - system routes stay reachable.
 */

const routesDir = fileURLToPath(new URL("../src/routes", import.meta.url));
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("route coverage: every user-facing page exactly once", () => {
  // Routes deliberately NOT in the semantic model: the API surface and the
  // first-run onboarding page (reached by redirect, not navigation).
  const EXCLUDED = new Set(["api", "welcome"]);

  function pageRoutes(): string[] {
    const dirs = readdirSync(routesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    const routes: string[] = [];
    for (const dir of dirs) {
      if (EXCLUDED.has(dir.name)) continue;
      if (readdirSync(`${routesDir}/${dir.name}`).includes("+page.svelte")) routes.push(`/${dir.name}`);
    }
    if (readdirSync(routesDir).includes("+page.svelte")) routes.push("/");
    return routes.sort();
  }

  it("the model covers every page route, each exactly once", () => {
    const routes = pageRoutes();
    const hrefs = ALL_NAV_ITEMS.map((i) => i.href);
    expect(hrefs, "duplicate nav entries").toHaveLength(new Set(hrefs).size);
    expect(new Set(hrefs)).toEqual(new Set(routes));
    expect(hrefs).toHaveLength(routes.length);
  });

  it("labels and hrefs are unique across the whole model", () => {
    const labels = ALL_NAV_ITEMS.map((i) => i.label);
    expect(labels).toHaveLength(new Set(labels).size);
  });

  it("system routes remain reachable in the model", () => {
    for (const href of ["/system", "/sync", "/changelog", "/settings"]) {
      expect(ALL_NAV_ITEMS.find((i) => i.href === href), `${href} missing`).toBeTruthy();
    }
  });

  it("mobile tabs + More sheet + persistent affordances cover every route", () => {
    const reachable = new Set([
      ...MOBILE_TABS.map((t) => t.href),
      ...MOBILE_SHEET_GROUPS.flatMap((g) => g.items.map((i) => i.href)),
      ...PERSISTENT_ITEMS.map((i) => i.href),
    ]);
    expect([...reachable].sort()).toEqual(ALL_NAV_ITEMS.map((i) => i.href).sort());
  });
});

describe("progressive disclosure structure", () => {
  it("max two levels: families contain only routes, never nested families", () => {
    for (const family of NAV_FAMILIES) {
      expect(family.children.length).toBeGreaterThan(0);
      for (const child of family.children) {
        expect(child).not.toHaveProperty("children");
      }
    }
  });

  it("analytics shows a handful of primary choices, not eleven", () => {
    // The old rail listed 11 analytics entries at once; the hub families
    // reduce the always-visible analytics surface to 3.
    const analytics = NAV_SECTIONS.find((s) => s.id === "analytics");
    expect(analytics?.entries).toHaveLength(0);
    expect(analytics?.families.map((f) => f.parent?.href)).toEqual(["/money", "/progression", "/activity"]);
  });

  it("EVERY family is hub-first — no clickable-looking header without action", () => {
    // 2.5.2 shipped a label-only "Rewards & games" family header that looked
    // exactly like the navigating hub families but did nothing (2.5.3 bug).
    // The model can no longer express that: every family MUST have a
    // navigating parent whose href is a real route in the model.
    for (const family of NAV_FAMILIES) {
      expect(family.parent, `family "${family.id}" has no hub parent`).toBeTruthy();
      expect(ALL_NAV_ITEMS.some((i) => i.href === family.parent!.href), `family "${family.id}" hub href not in model`).toBe(true);
      expect(ALL_NAV_ITEMS).toContain(family.parent);
      // The hub must not also be a child somewhere (single representation).
      for (const f of NAV_FAMILIES) expect(f.children).not.toContain(family.parent);
    }
    // The rail renders hubs as links and nothing inert: no header branch.
    const rail = read("../src/lib/components/NavRail.svelte");
    expect(rail).not.toContain("family.header");
  });

  it("the mobile sheet is a compact set of accordion groups", () => {
    // One group decision + one route tap: the sheet must stay a handful of
    // groups, each a scannable list — never a full route matrix.
    expect(MOBILE_SHEET_GROUPS.length).toBeLessThanOrEqual(8);
    const ids = MOBILE_SHEET_GROUPS.map((g) => g.id);
    expect(ids).toHaveLength(new Set(ids).size);
    const largest = Math.max(...MOBILE_SHEET_GROUPS.map((g) => g.items.length));
    expect(largest).toBeLessThanOrEqual(5);
  });
});

describe("active state derivation", () => {
  it("isActivePath keeps its deep-link semantics", () => {
    expect(isActivePath("/", "/")).toBe(true);
    expect(isActivePath("/today", "/")).toBe(false);
    expect(isActivePath("/today", "/today")).toBe(true);
    expect(isActivePath("/faction/ranked-wars", "/faction")).toBe(true);
    expect(isActivePath("/drugs", "/drugs")).toBe(true);
    expect(isActivePath("/drugstore", "/drugs")).toBe(false);
    // The rewards hub must not swallow /rewards or vice versa.
    expect(isActivePath("/rewards-games", "/rewards")).toBe(false);
    expect(isActivePath("/rewards", "/rewards-games")).toBe(false);
    expect(isActivePath("/rewards-games", "/rewards-games")).toBe(true);
  });

  it("the rewards & games hub leads its family on both form factors", () => {
    const family = familyForPath("/rewards-games");
    expect(family?.id).toBe("specialty");
    expect(family?.parent?.href).toBe("/rewards-games");
    expect(family?.children.map((c) => c.href)).toEqual(["/casino", "/rewards", "/hunting"]);
    // Mobile sheet mirrors the desktop hub-first structure.
    const sheetGroup = MOBILE_SHEET_GROUPS.find((g) => g.id === "specialty");
    expect(sheetGroup?.items[0]?.href).toBe("/rewards-games");
    // Header context resolves the hub like any other page.
    expect(activeItemForPath("/rewards-games")?.item.label).toBe("Rewards & games");
    expect(activeItemForPath("/casino")?.family?.id).toBe("specialty");
  });

  it("an active child activates its family (rail parent lights up)", () => {
    expect(familyForPath("/stocks")?.id).toBe("economy");
    expect(familyForPath("/drugs")?.id).toBe("progression");
    expect(familyForPath("/energy")?.id).toBe("progression");
    expect(familyForPath("/timeline")?.id).toBe("activity");
    expect(familyForPath("/logs")?.id).toBe("activity");
    // Hub pages themselves also expand their family.
    expect(familyForPath("/money")?.id).toBe("economy");
    expect(familyForPath("/progression")?.id).toBe("progression");
    // Flat pages belong to no family.
    expect(familyForPath("/crimes")).toBeNull();
    expect(familyForPath("/changelog")).toBeNull();
  });

  it("the active item resolves with full context for secondary pages", () => {
    const drugs = activeItemForPath("/drugs");
    expect(drugs?.item.label).toBe("Drugs");
    expect(drugs?.family?.id).toBe("progression");
    expect(drugs?.section?.id).toBe("analytics");

    const rankedWars = activeItemForPath("/faction/ranked-wars");
    expect(rankedWars?.item.label).toBe("Faction");

    const home = activeItemForPath("/");
    expect(home?.item.label).toBe("Overview");
    expect(home?.family).toBeUndefined();

    // Non-nav routes have no context (header shows no page label there).
    expect(activeItemForPath("/welcome")).toBeNull();
    expect(activeItemForPath("/definitely-not-a-page")).toBeNull();
  });

  it("the Activity mobile tab owns its family territory (Timeline, Logs)", () => {
    const activityTab = MOBILE_TABS.find((t) => t.href === "/activity");
    expect(activityTab).toBeTruthy();
    const family = familyForPath("/timeline");
    expect(family?.parent?.href).toBe(activityTab?.href);
    expect(family?.children.some((c) => c.href === "/logs")).toBe(true);
  });
});

describe("navigation components stay wired to the single model", () => {
  it("the rail renders collapsible families with ARIA state and local persistence", () => {
    const rail = read("../src/lib/components/NavRail.svelte");
    expect(rail).toContain('from "$lib/nav"');
    expect(rail).toContain("NAV_SECTIONS");
    expect(rail).toContain("aria-expanded=");
    expect(rail).toContain("aria-controls=");
    expect(rail).toContain("tornscope:nav-collapsed-families");
    // The active family must expand on arrival: navigation to a child clears
    // any sticky manual collapse for the newly-active family.
    expect(rail).toContain("active !== lastActiveFamilyId");
    expect(rail).toContain("family.id === activeFamilyId");
    // No hover-only disclosure: toggling is a real button.
    expect(rail).toMatch(/<button[^>]*aria-expanded/);
    // Hub-first interaction rule: label navigates (anchor), chevron toggles
    // (button) — clicking one can never trigger the other.
    expect(rail).toMatch(/<a\s+href=\{family\.parent\.href\}/);
    expect(rail).toMatch(/aria-expanded=\{expanded\}\s+aria-controls=\{"nav-family-/);
    // The chevron keeps an enlarged hit zone (pseudo-element inset) without
    // growing the visual footprint of the narrow icon-only rail.
    expect(rail).toContain("after:absolute");
    // On short screens the active row scrolls into the nav's view after a
    // route change — an expanded family must never hide the current page
    // below the fold.
    expect(rail).toContain('aside nav a[aria-current="page"]');
    expect(rail).toContain("scrollIntoView");
  });

  it("the mobile sheet is an accordion with Escape close and active group", () => {
    const mobile = read("../src/lib/components/MobileNav.svelte");
    expect(mobile).toContain("MOBILE_SHEET_GROUPS");
    expect(mobile).toContain('e.key === "Escape"');
    expect(mobile).toContain("aria-expanded=");
    expect(mobile).toContain('role="dialog"');
    expect(mobile).toContain("aria-modal");
    // Active group opens automatically (never buried).
    expect(mobile).toContain("activeGroup");
    // Focus returns to the More trigger when the sheet closes.
    expect(mobile).toContain("moreBtn?.focus()");
  });

  it("the mobile header derives current-page context from the model", () => {
    const header = read("../src/lib/components/Header.svelte");
    expect(header).toContain("activeItemForPath");
    expect(header).toContain("aria-current");
  });
});
