import { formatDateTime, formatDate } from "@tornscope/shared";

/** Relative time for sync/status readouts, e.g. "4m ago". */
export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * Absolute datetime rendered in the user's configured IANA timezone
 * (falls back to UTC), European order: "06-09-2026 14:35".
 */
export function formatDateTimeInZone(ts: number | null | undefined, timeZone: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timeZone || "UTC",
    }).formatToParts(d);
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    return `${get("day")}-${get("month")}-${get("year")} ${get("hour")}:${get("minute")}`;
  } catch {
    return formatDateTime(ts);
  }
}

/** Day-only variant in the configured zone, e.g. "06-09-2026". */
export function formatDateInZone(ts: number | null | undefined, timeZone: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: timeZone || "UTC",
    }).format(d);
  } catch {
    return formatDate(ts);
  }
}

/** Greeting word for a wall-clock hour (0–23) — callers pass the
 *  DISPLAY-zone hour (see td.displayHour), never the host/UTC clock. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
