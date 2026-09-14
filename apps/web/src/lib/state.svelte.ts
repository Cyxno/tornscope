import type { DateRangePreset } from "@tornscope/shared";

/**
 * Global app state (Svelte 5 runes module): current date range filter and
 * the signed-in player snapshot from /api/me.
 */

export const DATE_PRESETS: Array<{ value: DateRangePreset; label: string }> = [
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "14d", label: "14D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
  { value: "this_month", label: "Month" },
  { value: "this_year", label: "Year" },
  { value: "all", label: "All" },
];

/** Browser-local default range preference (Settings › General). Read once
 *  at module load; in-session range changes are never persisted back. */
function storedDefaultPreset(): DateRangePreset {
  if (typeof window === "undefined") return "30d";
  try {
    const raw = window.localStorage.getItem("tornscope.defaultRange.v1");
    return DATE_PRESETS.some((p) => p.value === raw) ? (raw as DateRangePreset) : "30d";
  } catch {
    return "30d";
  }
}

export const dateRange = $state<{ preset: DateRangePreset; from?: number; to?: number }>({ preset: storedDefaultPreset() });

export interface MeState {
  loaded: boolean;
  data: import("@tornscope/shared").MeResponse | null;
  error: string | null;
}

export const me = $state<MeState>({ loaded: false, data: null, error: null });

export async function refreshMe(): Promise<void> {
  const { endpoints } = await import("./api.js");
  try {
    me.data = await endpoints.me();
    me.error = null;
  } catch (err) {
    me.error = (err as Error).message;
  } finally {
    me.loaded = true;
  }
}

export function setPreset(preset: DateRangePreset): void {
  dateRange.preset = preset;
  dateRange.from = undefined;
  dateRange.to = undefined;
}

export function setCustomRange(from: number, to: number): void {
  dateRange.preset = "custom";
  dateRange.from = from;
  dateRange.to = to;
}

/* -------------------------------------------------------------------------- */
/* Presentation preferences: Simple/Advanced + Focus area (browser-local)     */
/* -------------------------------------------------------------------------- */

/**
 * Presentation model (product simplification):
 *
 * - `simple`    — the page answers "what happened?" first: wealth result,
 *                 biggest shifts, real gains/costs. Dense analytics move
 *                 behind disclosures / the Advanced toggle. Semantics are
 *                 never simplified away: residuals and estimates stay
 *                 visible and labeled.
 * - `advanced`  — the full pre-existing analytics surface, unchanged.
 *
 * Focus areas reorder Overview prominence per player goal. They are
 * PERSONALIZATION, not permissions: no route is hidden, no data is lost,
 * and "everything" (the default) preserves the current experience for
 * established users.
 *
 * Both are browser-local presentation preferences (same policy as the
 * default date range and appearance) — no account data, no migration.
 */

import type { DashboardMode, FocusArea } from "./focus.js";
import { FOCUS_AREAS } from "./focus.js";

export { DASHBOARD_MODES, FOCUS_AREAS, overviewSectionOrder } from "./focus.js";
export type { DashboardMode, FocusArea } from "./focus.js";

const MODE_KEY = "tornscope.mode.v1";
const FOCUS_KEY = "tornscope.focus.v1";

function storedMode(): DashboardMode {
  if (typeof window === "undefined") return "simple";
  try {
    const raw = window.localStorage.getItem(MODE_KEY);
    return raw === "advanced" ? "advanced" : "simple";
  } catch {
    return "simple";
  }
}

function storedFocus(): FocusArea {
  if (typeof window === "undefined") return "everything";
  try {
    const raw = window.localStorage.getItem(FOCUS_KEY);
    return FOCUS_AREAS.some((f) => f.value === raw) ? (raw as FocusArea) : "everything";
  } catch {
    return "everything";
  }
}

export const prefs = $state<{ mode: DashboardMode; focus: FocusArea }>({ mode: storedMode(), focus: storedFocus() });

export function setDashboardMode(mode: DashboardMode): void {
  prefs.mode = mode;
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private-mode storage failures just mean the choice is per-session.
  }
}

export function setFocusArea(area: FocusArea): void {
  prefs.focus = area;
  try {
    window.localStorage.setItem(FOCUS_KEY, area);
  } catch {
    // Per-session fallback as above.
  }
}
