/**
 * Focus areas + presentation mode constants and pure logic.
 *
 * Focus areas reorder Overview prominence per player goal. They are
 * PERSONALIZATION, not permissions: no route is hidden, no data is lost,
 * and "everything" (the default) preserves the current experience for
 * established users.
 *
 * Kept free of runes so the root vitest suite (no Svelte plugin) can unit
 * test the ordering logic directly.
 */

export type DashboardMode = "simple" | "advanced";
export type FocusArea = "everything" | "wealth" | "training" | "combat";

export const DASHBOARD_MODES: Array<{ value: DashboardMode; label: string }> = [
  { value: "simple", label: "Simple" },
  { value: "advanced", label: "Advanced" },
];

export const FOCUS_AREAS: Array<{ value: FocusArea; label: string; hint: string }> = [
  { value: "everything", label: "Everything", hint: "The balanced view — all sections in the default order." },
  { value: "wealth", label: "Wealth", hint: "Net worth and economy first." },
  { value: "training", label: "Training", hint: "Live energy and progression first." },
  { value: "combat", label: "Combat", hint: "Recent activity, combat and faction first." },
];

export type OverviewSectionKey = "live" | "networth" | "today" | "activity" | "beyond";

/**
 * Overview section order per focus area (lower renders first). Reorders
 * prominence only; "everything" is the historical order.
 */
export function overviewSectionOrder(focus: FocusArea): Record<OverviewSectionKey, number> {
  switch (focus) {
    case "wealth":
      return { networth: 1, today: 2, live: 3, activity: 4, beyond: 5 };
    case "training":
      return { live: 1, beyond: 2, today: 3, networth: 4, activity: 5 };
    case "combat":
      return { activity: 1, live: 2, today: 3, beyond: 4, networth: 5 };
    default:
      return { live: 1, networth: 2, today: 3, activity: 4, beyond: 5 };
  }
}
