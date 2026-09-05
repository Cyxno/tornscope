/**
 * Time bucketing helpers. All timestamps are unix seconds (UTC).
 * Buckets are keyed by their UTC start timestamp.
 */

export type Interval = "hour" | "day" | "week" | "month";

const HOUR = 3600;
const DAY = 86_400;

export function startOfHour(ts: number): number {
  return Math.floor(ts / HOUR) * HOUR;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

export function startOfWeek(ts: number): number {
  const d = new Date(ts * 1000);
  // Weeks start on Monday (UTC).
  const day = (d.getUTCDay() + 6) % 7;
  return startOfDay(ts) - day * DAY;
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

export function bucketStart(ts: number, interval: Interval): number {
  switch (interval) {
    case "hour":
      return startOfHour(ts);
    case "day":
      return startOfDay(ts);
    case "week":
      return startOfWeek(ts);
    case "month":
      return startOfMonth(ts);
  }
}

/**
 * Group items into UTC buckets. Returns a sorted array of
 * { bucketStart, items }. Items outside [from, to] are excluded.
 */
export function groupByBucket<T>(items: readonly T[], interval: Interval, getTimestamp: (item: T) => number, from?: number, to?: number): Array<{ bucket: number; items: T[] }> {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const ts = getTimestamp(item);
    if (from !== undefined && ts < from) continue;
    if (to !== undefined && ts > to) continue;
    const bucket = bucketStart(ts, interval);
    const list = map.get(bucket);
    if (list) list.push(item);
    else map.set(bucket, [item]);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([bucket, list]) => ({ bucket, items: list }));
}

export const groupByDay = <T>(items: readonly T[], getTs: (i: T) => number, from?: number, to?: number) => groupByBucket(items, "day", getTs, from, to);
export const groupByWeek = <T>(items: readonly T[], getTs: (i: T) => number, from?: number, to?: number) => groupByBucket(items, "week", getTs, from, to);
export const groupByMonth = <T>(items: readonly T[], getTs: (i: T) => number, from?: number, to?: number) => groupByBucket(items, "month", getTs, from, to);

/** Build a contiguous bucket axis between two timestamps. */
export function bucketAxis(from: number, to: number, interval: Interval): number[] {
  if (to < from) return [];
  const axis: number[] = [];
  let cursor = bucketStart(from, interval);
  const end = bucketStart(to, interval);
  // Guard against pathological ranges.
  if (interval === "hour" && end - cursor > 24 * 90 * HOUR) return [];
  while (cursor <= end) {
    axis.push(cursor);
    cursor = nextBucket(cursor, interval);
  }
  return axis;
}

function nextBucket(ts: number, interval: Interval): number {
  switch (interval) {
    case "hour":
      return ts + HOUR;
    case "day":
      return ts + DAY;
    case "week":
      return ts + 7 * DAY;
    case "month": {
      const d = new Date(ts * 1000);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
    }
  }
}

/** Running cumulative sum over points. */
export function cumulative(points: Array<{ t: number; value: number }>): Array<{ t: number; value: number }> {
  let running = 0;
  return points.map((p) => {
    running += p.value;
    return { t: p.t, value: running };
  });
}
