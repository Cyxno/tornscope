/**
 * Ingestion timestamp guard.
 *
 * Torn API timestamps are epoch SECONDS and are converted with
 * `new Date(sec * 1000)` at normalization time. A milliseconds-vs-seconds
 * slip anywhere upstream (or malformed historical payloads) would otherwise
 * persist Dates that PostgreSQL/Prisma cannot round-trip — which later breaks
 * every query touching the column, not just the offending row (1.0.0 shipped
 * one such bug on the notification query side).
 *
 * The guard is applied at the persistence boundary (repositories/ingest.ts):
 * implausible rows are DROPPED with a warning — never silently clamped to
 * "now", never written — so bad source data can never poison stored history.
 *
 * Bounds are deliberately conservative:
 *  - MIN: Torn launched in 2004; nothing legitimate predates it.
 *  - MAX: 48h of future drift tolerance for clock skew; real Torn
 *    timestamps are in the past or imminent.
 */

export const INGEST_MIN_EPOCH_SEC = Date.UTC(2004, 0, 1) / 1000;
export const INGEST_MAX_FUTURE_DRIFT_SEC = 48 * 3600;

export function isPlausibleIngestedDate(date: Date, now: Date = new Date()): boolean {
  const t = date.getTime();
  if (!Number.isFinite(t)) return false;
  return t >= INGEST_MIN_EPOCH_SEC * 1000 && t <= now.getTime() + INGEST_MAX_FUTURE_DRIFT_SEC * 1000;
}

/**
 * Split event rows into plausible vs implausible by their date field,
 * reporting rejections to stdout (worker/api run under process managers that
 * capture it). Returns only the plausible rows for persistence.
 */
export function rejectImplausibleRows<T>(
  rows: readonly T[],
  getDate: (row: T) => Date,
  describe: (row: T) => string,
  now: Date = new Date()
): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    if (isPlausibleIngestedDate(getDate(row), now)) {
      kept.push(row);
    } else {
      console.warn(
        `[ingest-guard] rejected implausible timestamp ${getDate(row).toISOString()} on ${describe(row)} — row dropped, never persisted`
      );
    }
  }
  return kept;
}
