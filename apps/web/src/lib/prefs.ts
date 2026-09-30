import type { DateRangePreset } from "@tornscope/shared";
import type { TimeDisplayMode } from "./datetime.js";

/**
 * Browser-local preference parsing (V1.0 sanity pass).
 *
 * One home for every localStorage key TornScope owns, for the range preset
 * vocabulary, and for PURE parsers that turn raw stored strings into safe
 * values. Every parser follows the same contract (Phase: storage sanity):
 *   null/absent  → the shipped default (first run / pre-QoL upgrade path)
 *   malformed    → the shipped default (never throws, never crashes)
 *   unknown value → the shipped default (forward compatibility)
 *
 * Kept free of runes so the root vitest suite can unit test the fallback
 * behavior directly (see apps/web/tests/prefs.test.ts).
 */

export const PREF_KEYS = {
  timeDisplay: "tornscope.timeDisplay.v1",
  defaultRange: "tornscope.defaultRange.v1",
  routeRanges: "tornscope.routeRange.v1",
  mode: "tornscope.mode.v1",
  focus: "tornscope.focus.v1",
} as const;

/** The range presets the segmented control offers, in display order.
 *  Single source of truth — the Settings default-range picker derives its
 *  subset from this list. */
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

/** Presets a route can remember — exactly what the range control offers
 *  (custom windows stay session-only). */
const REMEMBERABLE: readonly string[] = DATE_PRESETS.map((p) => p.value);

export const DEFAULT_RANGE_PRESETS = ["1d", "7d", "14d", "30d", "90d"] as const;

export type DefaultRange = (typeof DEFAULT_RANGE_PRESETS)[number];

export function parseTimeDisplay(raw: string | null): TimeDisplayMode {
  return raw === "torn" ? "torn" : "local";
}

export function parseDefaultRange(raw: string | null): DefaultRange {
  return (DEFAULT_RANGE_PRESETS as readonly string[]).includes(raw ?? "") ? (raw as DefaultRange) : "30d";
}

export function parseDashboardMode(raw: string | null): "simple" | "advanced" {
  return raw === "advanced" ? "advanced" : "simple";
}

/** `focus` values live in focus.ts (kept rune-free for the same reason);
 *  the whitelist is passed in so this module stays dependency-light. */
export function parseFocus<F extends string>(raw: string | null, valid: readonly F[], fallback: F): F {
  return (valid as readonly string[]).includes(raw ?? "") ? (raw as F) : fallback;
}

/** Parse the per-route range map. Invalid JSON, non-object shapes and
 *  unknown presets are dropped; the rest survives. Route keys are taken
 *  as-is (they are pathnames like "/money"). */
export function parseRouteRanges(raw: string | null): Record<string, DateRangePreset> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, DateRangePreset> = {};
  for (const [route, preset] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof preset === "string" && REMEMBERABLE.includes(preset)) {
      out[route] = preset as DateRangePreset;
    }
  }
  return out;
}

/** True when rememberRouteRange should persist the preset ("custom" is
 *  session-only by design). */
export function isRememberablePreset(preset: DateRangePreset): boolean {
  return REMEMBERABLE.includes(preset);
}

/* -------------------------------------------------------------------------- */
/* Heads-up device preferences (2.0.5) — per-BROWSER, on purpose               */
/* -------------------------------------------------------------------------- */

export const HEADSUP_PREF_KEYS = {
  cue: "tornscope.headsup.cue.v1",
  sound: "tornscope.headsup.sound.v1",
} as const;

/** Dashboard cue enabled (default on). Push is a separate, profile-level setting. */
export function parseHeadsupCue(raw: string | null): boolean {
  return raw === null ? true : raw === "1";
}

/** Local sound enabled (default OFF — explicit opt-in, never autoplay). */
export function parseHeadsupSound(raw: string | null): boolean {
  return raw === "1";
}
