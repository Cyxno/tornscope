import type { IconName } from "$lib/components/Icon.svelte";

/**
 * Primary navigation model — single source for the desktop header, the
 * tablet scroll row and the mobile tab bar/sheet. Route semantics never
 * change here; only presentation does.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** System pages sit at the end of the sheet and in the footer. */
  group: "core" | "analytics" | "intelligence" | "activity" | "system";
}

export const NAV_GROUPS: Array<{ id: NavItem["group"]; label: string; items: NavItem[] }> = [
  {
    id: "core",
    label: "Core",
    items: [
      { href: "/", label: "Overview", icon: "overview", group: "core" },
      { href: "/today", label: "Today", icon: "today", group: "core" },
    ],
  },
  {
    id: "intelligence",
    label: "Intelligence",
    items: [
      { href: "/goals", label: "Goals", icon: "goal", group: "intelligence" },
      { href: "/insights", label: "Insights", icon: "insight", group: "intelligence" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    items: [
      { href: "/money", label: "Economy", icon: "economy", group: "analytics" },
      { href: "/stocks", label: "Stocks", icon: "stocks", group: "analytics" },
      { href: "/progression", label: "Progression", icon: "progression", group: "analytics" },
      { href: "/energy", label: "Energy", icon: "progression", group: "analytics" },
      { href: "/merits", label: "Merits", icon: "merits", group: "analytics" },
      { href: "/drugs", label: "Drugs", icon: "drugs", group: "analytics" },
      { href: "/travel", label: "Travel", icon: "travel", group: "analytics" },
      { href: "/casino", label: "Casino", icon: "slots", group: "analytics" },
      { href: "/rewards", label: "Rewards", icon: "cache", group: "analytics" },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    items: [
      { href: "/crimes", label: "Crimes", icon: "crimes", group: "activity" },
      { href: "/combat", label: "Combat", icon: "combat", group: "activity" },
      { href: "/faction", label: "Faction", icon: "faction", group: "activity" },
      { href: "/timeline", label: "Timeline", icon: "timeline", group: "activity" },
      { href: "/logs", label: "Logs", icon: "logs", group: "activity" },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      { href: "/system", label: "System health", icon: "sync", group: "system" },
      { href: "/sync", label: "Sync status", icon: "sync", group: "system" },
      { href: "/changelog", label: "Changelog", icon: "changelog", group: "system" },
      { href: "/settings", label: "Settings", icon: "settings", group: "system" },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Mobile tab bar: the two core pages, the richest activity feed, then More. */
export const MOBILE_TABS: NavItem[] = [
  { href: "/", label: "Overview", icon: "overview", group: "core" },
  { href: "/today", label: "Today", icon: "today", group: "core" },
  { href: "/timeline", label: "Timeline", icon: "timeline", group: "activity" },
];

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
