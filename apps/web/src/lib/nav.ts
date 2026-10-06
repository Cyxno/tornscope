import type { IconName } from "$lib/components/Icon.svelte";

/**
 * Navigation model — the ONE semantic source for the desktop rail, the
 * mobile tab bar and the mobile More sheet. Route semantics (hrefs) never
 * change here; only presentation does.
 *
 * IA (2.5.2): progressive disclosure. Primary destinations stay always
 * visible; secondary pages live exactly one interaction away inside
 * collapsible families. Max two levels (family → route) — pages themselves
 * own any deeper tabs. Nothing is removed from the model: every user-facing
 * route appears exactly once (nav.test.ts pins that).
 */

export type NavSectionId = "core" | "intelligence" | "analytics" | "gameplay" | "specialty" | "system";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  section: NavSectionId;
}

/** A collapsible unit: a hub page with its secondary children, or a
 * label-only header group when no natural hub page exists. */
export interface NavFamily {
  /** Stable key for collapse-state persistence. */
  id: string;
  section: NavSectionId;
  /** Navigating hub page, when one exists. */
  parent?: NavItem;
  /** Label-only collapsible header when the family has no hub page. */
  header?: { label: string; icon: IconName };
  children: NavItem[];
}

export interface NavSection {
  id: NavSectionId;
  label: string;
  /** Always-visible rows. */
  entries: NavItem[];
  /** Collapsible families — secondary disclosure. */
  families: NavFamily[];
}

// ---- Items -------------------------------------------------------------------

const overview: NavItem = { href: "/", label: "Overview", icon: "overview", section: "core" };
const today: NavItem = { href: "/today", label: "Today", icon: "today", section: "core" };
const goals: NavItem = { href: "/goals", label: "Goals", icon: "goal", section: "intelligence" };
const insights: NavItem = { href: "/insights", label: "Insights", icon: "insight", section: "intelligence" };
const economy: NavItem = { href: "/money", label: "Economy", icon: "economy", section: "analytics" };
const progression: NavItem = { href: "/progression", label: "Progression", icon: "progression", section: "analytics" };
const activity: NavItem = { href: "/activity", label: "Activity", icon: "activity", section: "analytics" };
const stocks: NavItem = { href: "/stocks", label: "Stocks", icon: "stocks", section: "analytics" };
const energy: NavItem = { href: "/energy", label: "Energy", icon: "progression", section: "analytics" };
const merits: NavItem = { href: "/merits", label: "Merits", icon: "merits", section: "analytics" };
const drugs: NavItem = { href: "/drugs", label: "Drugs", icon: "drugs", section: "analytics" };
const timeline: NavItem = { href: "/timeline", label: "Timeline", icon: "timeline", section: "analytics" };
const logs: NavItem = { href: "/logs", label: "Logs", icon: "logs", section: "analytics" };
const crimes: NavItem = { href: "/crimes", label: "Crimes", icon: "crimes", section: "gameplay" };
const combat: NavItem = { href: "/combat", label: "Combat", icon: "combat", section: "gameplay" };
const faction: NavItem = { href: "/faction", label: "Faction", icon: "faction", section: "gameplay" };
const travel: NavItem = { href: "/travel", label: "Travel", icon: "travel", section: "gameplay" };
const casino: NavItem = { href: "/casino", label: "Casino", icon: "slots", section: "specialty" };
const rewards: NavItem = { href: "/rewards", label: "Rewards", icon: "cache", section: "specialty" };
const hunting: NavItem = { href: "/hunting", label: "Hunting", icon: "hunting", section: "specialty" };
const systemHealth: NavItem = { href: "/system", label: "System health", icon: "sync", section: "system" };
const changelog: NavItem = { href: "/changelog", label: "Changelog", icon: "changelog", section: "system" };

/**
 * Persistent affordances rather than list rows: sync lives as the live
 * pulse and settings as the identity control (rail footer / mobile header).
 * They stay part of the semantic model so every route is represented
 * exactly once and the mobile System group can include them.
 */
export const PERSISTENT_ITEMS: NavItem[] = [
  { href: "/sync", label: "Sync status", icon: "sync", section: "system" },
  { href: "/settings", label: "Settings", icon: "settings", section: "system" },
];

// ---- Structure -----------------------------------------------------------------

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "core",
    label: "Core",
    entries: [overview, today],
    families: [],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    entries: [goals, insights],
    families: [],
  },
  {
    id: "analytics",
    label: "Analytics",
    entries: [],
    families: [
      // Real hub pages lead their families: /money, /progression and
      // /activity are first-class pages, not invented headers.
      { id: "economy", section: "analytics", parent: economy, children: [stocks] },
      { id: "progression", section: "analytics", parent: progression, children: [energy, merits, drugs] },
      { id: "activity", section: "analytics", parent: activity, children: [timeline, logs] },
    ],
  },
  {
    id: "gameplay",
    label: "Gameplay",
    entries: [crimes, combat, faction, travel],
    families: [],
  },
  {
    id: "specialty",
    label: "Rewards & games",
    entries: [],
    families: [
      // No single hub page covers casino + rewards + hunting, so this family
      // uses a label-only header instead of inventing a fake landing page.
      { id: "specialty", section: "specialty", header: { label: "Rewards & games", icon: "slots" }, children: [casino, rewards, hunting] },
    ],
  },
  {
    id: "system",
    label: "System",
    entries: [systemHealth, changelog],
    families: [],
  },
];

/** Every user-facing route, exactly once (test-pinned). */
export const ALL_NAV_ITEMS: NavItem[] = [
  ...NAV_SECTIONS.flatMap((s) => [
    ...s.entries,
    ...s.families.flatMap((f) => [...(f.parent ? [f.parent] : []), ...f.children]),
  ]),
  ...PERSISTENT_ITEMS,
];

/** Desktop rail: collapsible families (secondary pages hidden when collapsed). */
export const NAV_FAMILIES: NavFamily[] = NAV_SECTIONS.flatMap((s) => s.families);

/**
 * Mobile More sheet groups — the same semantic families, flattened to
 * accordion groups (the hub page is included as its own row). Core pages
 * live in the tab bar; Intelligence/Gameplay/System become label-header
 * groups so the sheet stays ~7 group decisions instead of a route matrix.
 */
export const MOBILE_SHEET_GROUPS: Array<{ id: string; label: string; icon: IconName; items: NavItem[] }> = [
  { id: "intelligence", label: "Intelligence", icon: "insight", items: [goals, insights] },
  { id: "economy", label: "Economy", icon: economy.icon, items: [economy, stocks] },
  { id: "progression", label: "Progression", icon: progression.icon, items: [progression, energy, merits, drugs] },
  { id: "activity", label: "Activity", icon: activity.icon, items: [activity, timeline, logs] },
  { id: "gameplay", label: "Gameplay", icon: "combat", items: [crimes, combat, faction, travel] },
  { id: "specialty", label: "Rewards & games", icon: "slots", items: [casino, rewards, hunting] },
  { id: "system", label: "System", icon: "sync", items: [systemHealth, changelog, ...PERSISTENT_ITEMS] },
];

/**
 * Mobile tab bar: the two core pages plus the analytics hub closest to the
 * app's core promise. The Activity tab also covers its family (Timeline,
 * Logs) so a history page keeps a lit tab.
 */
export const MOBILE_TABS: NavItem[] = [overview, today, activity];

// ---- Active-state helpers --------------------------------------------------------

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The nav item matching a pathname (longest href wins), or null for
 * non-nav routes such as /welcome. */
export function activeItemForPath(pathname: string): { item: NavItem; section?: NavSection; family?: NavFamily } | null {
  let best: NavItem | null = null;
  for (const item of ALL_NAV_ITEMS) {
    if (isActivePath(pathname, item.href) && (!best || item.href.length > best.href.length)) best = item;
  }
  if (!best) return null;
  const section = NAV_SECTIONS.find((s) => s.id === best.section);
  const family = NAV_FAMILIES.find((f) => (f.parent && f.parent === best) || f.children.includes(best));
  return { item: best, section, family };
}

/** The family whose parent or children own a pathname — the rail uses this
 * to auto-expand the group that contains the current page. */
export function familyForPath(pathname: string): NavFamily | null {
  return (
    NAV_FAMILIES.find(
      (f) => (f.parent && isActivePath(pathname, f.parent.href)) || f.children.some((c) => isActivePath(pathname, c.href)),
    ) ?? null
  );
}
