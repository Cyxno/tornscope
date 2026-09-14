import {
  alternateTimeTooltip as alternateTimeTooltipPure,
  alternateZone,
  chartDayLabel,
  chartHourLabel,
  displayDate as displayDatePure,
  displayDateTime as displayDateTimePure,
  displayDayHeading as displayDayHeadingPure,
  displayTime as displayTimePure,
  type TimeDisplayMode,
} from "./datetime.js";

/**
 * Time DISPLAY preference (browser-local, V1.0 QOL pass):
 *   "local" (default) — the browser device timezone
 *   "torn"            — Torn server time (UTC)
 *
 * Presentation only: analytics day boundaries and canonical storage stay
 * UTC (see docs/DATETIME.md). SSR resolves to UTC until the client states
 * its zone, so server output never bakes in a server timezone.
 */

export type { TimeDisplayMode };

const TIME_DISPLAY_KEY = "tornscope.timeDisplay.v1";

function storedTimeDisplay(): TimeDisplayMode {
  if (typeof window === "undefined") return "local";
  try {
    const raw = window.localStorage.getItem(TIME_DISPLAY_KEY);
    return raw === "torn" ? "torn" : "local";
  } catch {
    return "local";
  }
}

export const timeDisplay = $state<{ mode: TimeDisplayMode }>({ mode: storedTimeDisplay() });

export function setTimeDisplay(mode: TimeDisplayMode): void {
  timeDisplay.mode = mode;
  try {
    window.localStorage.setItem(TIME_DISPLAY_KEY, mode);
  } catch {
    /* storage unavailable */
  }
}

/** The IANA zone timestamps currently display in. */
export function displayTimeZone(): string {
  return timeDisplay.mode === "torn" ? "UTC" : browserTimeZoneSafe();
}

function browserTimeZoneSafe(): string {
  if (typeof window === "undefined") return "UTC";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function displayDate(ts: number | null | undefined): string {
  return displayDatePure(ts, displayTimeZone());
}

export function displayTime(ts: number | null | undefined): string {
  return displayTimePure(ts, displayTimeZone());
}

export function displayDateTime(ts: number | null | undefined): string {
  return displayDateTimePure(ts, displayTimeZone());
}

export function displayDayHeading(ts: number): string {
  return displayDayHeadingPure(ts, displayTimeZone());
}

export function chartDay(ts: number): string {
  return chartDayLabel(ts, displayTimeZone());
}

export function chartHour(ts: number): string {
  return chartHourLabel(ts, displayTimeZone());
}

/** Alternate-zone tooltip, e.g. "14-09-2026 19:43 Torn time (UTC)". */
export function alternateTimeTooltip(ts: number | null | undefined): string {
  if (!ts) return "";
  return alternateTimeTooltipPure(ts, timeDisplay.mode, browserTimeZoneSafe());
}

/** Caption for the alternate zone, e.g. "Torn time (UTC)". */
export function alternateZoneLabel(): string {
  return zoneLabel(alternateZone(timeDisplay.mode, browserTimeZoneSafe()));
}

/** Caption for the zone currently displayed. */
export function currentZoneLabel(): string {
  return zoneLabel(displayTimeZone());
}

function zoneLabel(zone: string): string {
  return zone === "UTC" ? "Torn time (UTC)" : `${zone} local time`;
}
