/**
 * Daily Summary date semantics.
 *
 * A "day" is the CALENDAR DAY IN THE USER'S CONFIGURED TIMEZONE
 * (User.timezone, IANA; defaults to "UTC" — which every existing profile
 * effectively uses, so UTC behavior is unchanged until a real zone is set).
 * All internal data stays unix seconds; only the day BOUNDARY interpretation
 * is timezone-aware. DST is handled by resolving the local midnight via
 * Intl offset lookups (a 23/25-hour day yields correspondingly shorter/longer
 * bounds); a malformed timezone falls back to UTC, mirroring the quiet-hours
 * engine's behavior.
 */

const DAY_PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayPartFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = DAY_PART_FORMATTERS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    DAY_PART_FORMATTERS.set(timeZone, fmt);
  }
  return fmt;
}

/** False for garbage like "not-a-zone" — callers then fall back to UTC. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` from UTC, in seconds, at the given instant. */
function tzOffsetSeconds(utcSeconds: number, timeZone: string): number {
  const parts = new Map(
    dayPartFormatter(timeZone).formatToParts(new Date(utcSeconds * 1000)).map((p) => [p.type, p.value] as const)
  );
  const asUtc = Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month"))! - 1,
    Number(parts.get("day"))!,
    Number(parts.get("hour"))! % 24,
    Number(parts.get("minute"))!,
    Number(parts.get("second"))!
  ) / 1000;
  return asUtc - utcSeconds;
}

/** "YYYY-MM-DD" of the given instant, in the given timezone. */
export function dayKeyInZone(utcSeconds: number, timeZone: string): string {
  const shifted = new Date((utcSeconds + tzOffsetSeconds(utcSeconds, timeZone)) * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const utc = new Date(Date.UTC(y, m - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === m - 1 && utc.getUTCDate() === d;
}

export interface ResolvedDay {
  /** Normalized "YYYY-MM-DD" key (the requested calendar day). */
  dateKey: string;
  /** Inclusive local-midnight bound, unix seconds. */
  from: number;
  /** Inclusive local-end-of-day bound, unix seconds. */
  to: number;
  /** The requested day is the current calendar day in the timezone. */
  isToday: boolean;
  /** True while the day is still ongoing (today) — completeness must be capped. */
  ongoing: boolean;
}

/**
 * Resolve a requested calendar day to exact query bounds in the timezone.
 *
 * `dateKey` must be "YYYY-MM-DD"; undefined/null means "today" in the
 * timezone. Future days are rejected (there is no summary for a day that has
 * not happened) — callers translate this into a 4xx.
 */
export function resolveDayRange(dateKey: string | null | undefined, timezone: string, now: number = Math.floor(Date.now() / 1000)): ResolvedDay {
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  const key = dateKey === undefined || dateKey === null || dateKey === "" ? dayKeyInZone(now, tz) : dateKey;
  if (!isValidDayKey(key)) {
    throw new Error(`invalid date: ${dateKey}`);
  }
  const todayKey = dayKeyInZone(now, tz);
  if (key > todayKey) {
    throw new Error("date is in the future");
  }

  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  // Treat the key as UTC midnight, then find the instant whose LOCAL time is
  // that midnight: fixed-point iteration of start = key - offset(start).
  // Two refinements handle DST transitions at/next to midnight.
  const guess = Date.UTC(y, m - 1, d) / 1000;
  let start = guess - tzOffsetSeconds(guess, tz);
  start = guess - tzOffsetSeconds(start, tz);
  start = guess - tzOffsetSeconds(start, tz);
  const nextKey = nextDayKey(key);
  const [ny, nm, nd] = nextKey.split("-").map(Number) as [number, number, number];
  let nextStart = Date.UTC(ny, nm - 1, nd) / 1000 - tzOffsetSeconds(Date.UTC(ny, nm - 1, nd) / 1000, tz);
  nextStart = Date.UTC(ny, nm - 1, nd) / 1000 - tzOffsetSeconds(nextStart, tz);
  nextStart = Date.UTC(ny, nm - 1, nd) / 1000 - tzOffsetSeconds(nextStart, tz);

  return { dateKey: key, from: start, to: nextStart - 1, isToday: key === todayKey, ongoing: key === todayKey };
}

function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}
