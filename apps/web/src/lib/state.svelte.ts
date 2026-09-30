import type { DateRangePreset } from "@tornscope/shared";
import { DATE_PRESETS, PREF_KEYS, isRememberablePreset, parseDashboardMode, parseDefaultRange, parseFocus, parseRouteRanges, HEADSUP_PREF_KEYS, parseHeadsupCue, parseHeadsupSound } from "./prefs.js";
import { FOCUS_AREAS } from "./focus.js";

/**
 * Global app state (Svelte 5 runes module): current date range filter and
 * the signed-in player snapshot from /api/me.
 */

export { DATE_PRESETS };

/** Browser-local default range preference (Settings › General). Read once
 *  at module load; in-session range changes are never persisted back. */
function storedDefaultPreset(): DateRangePreset {
  if (typeof window === "undefined") return "30d";
  try {
    return parseDefaultRange(window.localStorage.getItem(PREF_KEYS.defaultRange));
  } catch {
    return "30d";
  }
}

export const dateRange = $state<{ preset: DateRangePreset; from?: number; to?: number }>({ preset: storedDefaultPreset() });

/** The Settings default range — the fallback for routes without their own
 *  remembered preset (keeps routes isolated from each other). */
export function defaultPreset(): DateRangePreset {
  return storedDefaultPreset();
}

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

/** Per-route range memory (V1.0 QOL): each analytics route remembers its
 *  own preset in this browser. Custom windows stay session-only. Parsing
 *  lives in prefs.ts (pure, testable): unknown presets and malformed JSON
 *  are dropped, never crashed on. */
const ROUTE_RANGES_KEY = PREF_KEYS.routeRanges;
const routeRanges: Record<string, DateRangePreset> = loadRouteRanges();

function loadRouteRanges(): Record<string, DateRangePreset> {
  if (typeof window === "undefined") return {};
  try {
    return parseRouteRanges(window.localStorage.getItem(ROUTE_RANGES_KEY));
  } catch {
    return {};
  }
}

export function rememberRouteRange(route: string, preset: DateRangePreset): void {
  if (!isRememberablePreset(preset)) return;
  routeRanges[route] = preset;
  try {
    window.localStorage.setItem(ROUTE_RANGES_KEY, JSON.stringify(routeRanges));
  } catch {
    /* storage unavailable */
  }
}

export function routeRange(route: string): DateRangePreset | null {
  const preset = routeRanges[route];
  return DATE_PRESETS.some((p) => p.value === preset) ? preset : null;
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

export { DASHBOARD_MODES, FOCUS_AREAS, overviewSectionOrder } from "./focus.js";
export type { DashboardMode, FocusArea } from "./focus.js";

const MODE_KEY = PREF_KEYS.mode;
const FOCUS_KEY = PREF_KEYS.focus;

function storedMode(): DashboardMode {
  if (typeof window === "undefined") return "simple";
  try {
    return parseDashboardMode(window.localStorage.getItem(MODE_KEY));
  } catch {
    return "simple";
  }
}

function storedFocus(): FocusArea {
  if (typeof window === "undefined") return "everything";
  try {
    return parseFocus(window.localStorage.getItem(FOCUS_KEY), FOCUS_AREAS.map((f) => f.value), "everything");
  } catch {
    return "everything";
  }
}

function storedHeadsupCue(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return parseHeadsupCue(window.localStorage.getItem(HEADSUP_PREF_KEYS.cue));
  } catch {
    return true;
  }
}

function storedHeadsupSound(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return parseHeadsupSound(window.localStorage.getItem(HEADSUP_PREF_KEYS.sound));
  } catch {
    return false;
  }
}

export const prefs = $state<{ mode: DashboardMode; focus: FocusArea; headsupCue: boolean; headsupSound: boolean }>({
  mode: storedMode(),
  focus: storedFocus(),
  headsupCue: storedHeadsupCue(),
  headsupSound: storedHeadsupSound(),
});

export function setHeadsupCue(on: boolean): void {
  prefs.headsupCue = on;
  try {
    window.localStorage.setItem(HEADSUP_PREF_KEYS.cue, on ? "1" : "0");
  } catch {
    // Per-session fallback as above.
  }
}

export function setHeadsupSound(on: boolean): void {
  prefs.headsupSound = on;
  try {
    window.localStorage.setItem(HEADSUP_PREF_KEYS.sound, on ? "1" : "0");
  } catch {
    // Per-session fallback as above.
  }
}

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
