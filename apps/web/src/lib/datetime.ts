/**
 * Central display date/time contract (V1.0 QOL pass).
 *
 * CANONICAL: every timestamp is stored and computed in UTC epoch seconds;
 * nothing here mutates that.
 *
 * PRESENTATION: rendering takes an explicit IANA timezone —
 *   "local" mode → the browser device zone (resolved by the caller),
 *   "torn" mode → UTC (Torn server time).
 * Route components read the preference via time-state.svelte.ts; these pure
 * helpers stay runnable in the root vitest suite.
 *
 * FORMAT HIERARCHY (intentional, not accidental):
 *   tables/events  — "14-09-2026 23:43" (display zone)
 *   headings       — "Friday 4 Sep" long day style (display zone)
 *   chart axes     — compact "14/9" / "23:43" (display zone)
 *   relative age   — "3m ago" via formatRelative (freshness only; never the
 *                    sole label for history events)
 *
 * DST: Intl.DateTimeFormat resolves the HISTORICAL offset for each
 * timestamp's own instant (Europe/Amsterdam CET/CEST handled by the
 * platform, never manual arithmetic).
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  let f = formatterCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: zone, hour12: false });
    formatterCache.set(key, f);
  }
  return f;
}

function parts(ts: number, zone: string, options: Intl.DateTimeFormatOptions): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const p of cachedFormatter(zone, options).formatToParts(new Date(ts * 1000))) {
      if (p.type !== "literal") map.set(p.type, p.value);
    }
  } catch {
    // Unknown zone — fall back to canonical UTC formatting.
    return parts(ts, "UTC", options);
  }
  return map;
}

const pad2 = (n: string): string => n.padStart(2, "0");

/** "14-09-2026" in the display zone. */
export function displayDate(ts: number | null | undefined, zone: string): string {
  if (!ts) return "—";
  const p = parts(ts, zone, { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${pad2(p.get("day") ?? "")}-${pad2(p.get("month") ?? "")}-${p.get("year") ?? ""}`;
}

/** "23:43" in the display zone. */
export function displayTime(ts: number | null | undefined, zone: string): string {
  if (!ts) return "—";
  const p = parts(ts, zone, { hour: "2-digit", minute: "2-digit" });
  return `${pad2(p.get("hour") ?? "")}:${pad2(p.get("minute") ?? "")}`;
}

/** "14-09-2026 23:43" in the display zone. */
export function displayDateTime(ts: number | null | undefined, zone: string): string {
  if (!ts) return "—";
  return `${displayDate(ts, zone)} ${displayTime(ts, zone)}`;
}

/** Long day heading, e.g. "Sunday 14 Sep". */
export function displayDayHeading(ts: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: zone }).format(
      new Date(ts * 1000)
    );
  } catch {
    return formatDayHeadingFallback(ts);
  }
}

function formatDayHeadingFallback(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}

/** Compact chart axis labels in the display zone. */
export function chartDayLabel(ts: number, zone: string): string {
  const p = parts(ts, zone, { day: "numeric", month: "numeric" });
  return `${Number(p.get("day"))}/${Number(p.get("month"))}`;
}

export function chartHourLabel(ts: number, zone: string): string {
  return displayTime(ts, zone);
}

/** The timezone the OTHER mode would show, for alternate-time tooltips. */
export type TimeDisplayMode = "local" | "torn";

export function alternateZone(mode: TimeDisplayMode, browserZone: string): string {
  return mode === "torn" ? browserZone : "UTC";
}

/**
 * Alternate-time tooltip text. Local mode shows the Torn (UTC) time; Torn
 * mode shows the local time. The label always names the zone so a
 * near-midnight date shift reads correctly.
 */
export function alternateTimeTooltip(ts: number, mode: TimeDisplayMode, browserZone: string): string {
  if (mode === "torn") {
    return `${displayDateTime(ts, browserZone)} local time`;
  }
  return `${displayDateTime(ts, "UTC")} Torn time (UTC)`;
}

/**
 * The browser device IANA zone — the "local" mode target. Server callers
 * resolve to UTC so SSR output stays hydration-stable before the client
 * knows its zone.
 */
export function browserTimeZone(): string {
  if (typeof window === "undefined") return "UTC"; // SSR: hydration-stable UTC default
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Pluralize a count with a stable unit: "1 session" / "2 sessions". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
