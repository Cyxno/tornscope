/** Relative time for sync/status readouts, e.g. "4m ago". */
export function formatRelative(ts: number | null | undefined): string {
  if (!ts) return "never";
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

/** "Friday, Sep 4" style UTC day label for the journal feed. */
export function formatDayHeading(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "22:18" UTC clock time. */
export function formatClock(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
