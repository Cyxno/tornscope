/**
 * Defensive value extraction from Torn log `data`/`params` payloads.
 *
 * Torn's OpenAPI spec documents log `data` as "Dynamic key-value pairs
 * related to the log" - the field names are NOT part of the API contract.
 * We therefore:
 *   1. try a list of plausible candidate keys (ordered),
 *   2. accept only values of the expected shape,
 *   3. keep the raw payload in JSONB so parsing can improve later
 *      without any data loss.
 * Nothing here invents values: if no candidate matches, we return null and
 * the metric is either omitted or clearly labeled as estimated at read time.
 */

export type LogRecord = Record<string, unknown>;

export function pickNumber(record: LogRecord, candidates: string[]): number | null {
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

export function pickString(record: LogRecord, candidates: string[]): string | null {
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** Prefer a nested record such as `data.item = { id, name }`. */
export function pickNestedNumber(record: LogRecord, containers: string[], keys: string[]): number | null {
  for (const container of containers) {
    const inner = record[container];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const value = pickNumber(inner as LogRecord, keys);
      if (value !== null) return value;
    }
  }
  return null;
}

export function pickNestedString(record: LogRecord, containers: string[], keys: string[]): string | null {
  for (const container of containers) {
    const inner = record[container];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const value = pickString(inner as LogRecord, keys);
      if (value !== null) return value;
    }
  }
  return null;
}

/** Compose a stable source reference for deduplication. */
export function sourceRef(parts: (string | number | null | undefined)[]): string {
  return parts
    .map((p) => (p === null || p === undefined ? "" : String(p)))
    .filter((p) => p !== "")
    .join(":");
}

/** Strip Torn event HTML to a readable summary. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
