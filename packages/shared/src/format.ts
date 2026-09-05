/** Format an amount of Torn dollars compactly, e.g. $12.4m / $1.25b. */
export function formatMoneyCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}t`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}b`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}m`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Full money formatting, e.g. $1,234,567. */
export function formatMoneyFull(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function formatSignedMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatMoneyFull(value)}`;
}

/** Format unix seconds as a short UTC datetime, e.g. 2026-09-04 22:18. */
export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/**
 * Zero-vs-unknown semantics for KPI display.
 *
 * $0 is only shown when the value is a CONFIRMED zero (availability "ok" or
 * absent). Otherwise:
 *   "Importing"  — the historical backfill is still running
 *   "Incomplete" — parser coverage insufficient; the number may change
 *   "—"          — not computable from the collected data
 */
export function formatKpiValue(
  kpi: { value: number | null; availability?: "ok" | "unavailable" | "importing" | "incomplete" },
  format: (value: number | null | undefined) => string = formatMoneyCompact
): string {
  if (kpi.availability === "importing") return "Importing";
  if (kpi.availability === "incomplete" && kpi.value === null) return "Incomplete";
  if (kpi.value === null || kpi.availability === "unavailable") return "—";
  return format(kpi.value);
}
