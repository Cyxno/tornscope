import type { Provenance } from "@tornscope/shared";

/**
 * Unified timeline building. Merges heterogeneous event sources into a
 * single descending chronological feed.
 */

export interface TimelineItemLike {
  occurredAt: number;
  type: string;
  category?: string | null;
  title: string;
  description?: string | null;
  amount?: number | null;
  source?: string;
  provenance?: Provenance;
}

export interface TimelineItem extends TimelineItemLike {
  id: string;
  provenance: Provenance;
}

export function buildTimeline(
  sources: readonly (readonly TimelineItemLike[])[],
  options: { limit?: number; from?: number; to?: number } = {}
): TimelineItem[] {
  const merged: TimelineItem[] = [];
  let index = 0;
  for (const source of sources) {
    for (const item of source) {
      if (options.from !== undefined && item.occurredAt < options.from) continue;
      if (options.to !== undefined && item.occurredAt > options.to) continue;
      merged.push({
        id: `${item.source ?? "event"}-${index++}`,
        occurredAt: item.occurredAt,
        type: item.type,
        category: item.category ?? null,
        title: item.title,
        description: item.description ?? null,
        amount: item.amount ?? null,
        source: item.source ?? "unknown",
        provenance: item.provenance ?? "exact",
      });
    }
  }
  merged.sort((a, b) => b.occurredAt - a.occurredAt);
  return options.limit ? merged.slice(0, options.limit) : merged;
}

/** Group descending timeline items by UTC day for the UI feed. */
export function groupTimelineByDay(items: readonly TimelineItem[]): Array<{ day: number; items: TimelineItem[] }> {
  const map = new Map<number, TimelineItem[]>();
  for (const item of items) {
    const d = new Date(item.occurredAt * 1000);
    const day = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
    const list = map.get(day);
    if (list) list.push(item);
    else map.set(day, [item]);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([day, list]) => ({ day, items: list }));
}
