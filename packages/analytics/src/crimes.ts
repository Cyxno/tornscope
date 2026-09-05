import type { Provenance } from "@tornscope/shared";
import { bucketAxis, bucketStart } from "./series.js";

/**
 * Crimes analytics over normalized CrimeEvents.
 *
 * Cash values are EXACT (Torn-reported money_gained/money_lost). Item reward
 * values are ESTIMATES from the Torn item catalog. Nerve analytics are only
 * produced when nerve data actually exists — never fabricated.
 */

export interface CrimeEventLike {
  occurredAt: number;
  crimeName: string | null;
  success: boolean;
  nerveUsed: number | null;
  moneyDelta: number | null; // signed
  itemsValue: number | null;
  jailSeconds: number | null;
}

export interface CrimeBreakdownRow {
  crime: string;
  attempts: number;
  successes: number;
  successRate: number | null;
  cashGained: number;
  cashLost: number;
  estimatedItemsValue: number | null;
  netValue: number | null;
  nerveUsed: number | null;
  valuePerNerve: number | null;
}

export interface CrimeStats {
  attempts: number;
  successful: number;
  failed: number;
  successRate: number | null;
  moneyGained: number;
  moneyLost: number;
  netCrimeCash: number;
  estimatedItemsValue: number | null;
  totalEstimatedValue: number | null;
  nerveUsed: number | null;
  valuePerNerve: number | null;
  jailedCount: number;
  totalJailSeconds: number;
  crimesPerDay: number;
  byCrime: CrimeBreakdownRow[];
  dailySeries: Array<{ t: number; attempts: number; successes: number; value: number }>;
  provenance: Provenance;
}

export function aggregateCrimeStats(events: readonly CrimeEventLike[], from: number, to: number): CrimeStats {
  const inRange = events.filter((e) => e.occurredAt >= from && e.occurredAt <= to);

  let successful = 0;
  let moneyGained = 0;
  let moneyLost = 0;
  let itemsValue = 0;
  let itemsKnown = 0;
  let nerveUsed = 0;
  let nerveKnown = 0;
  let jailedCount = 0;
  let totalJailSeconds = 0;
  const byCrime = new Map<string, { attempts: number; successes: number; cash: number; cashLost: number; items: number; itemsKnown: number; nerve: number; nerveKnown: number }>();
  const byDay = new Map<number, { attempts: number; successes: number; value: number }>();

  for (const e of inRange) {
    if (e.success) successful += 1;
    if (e.moneyDelta !== null && e.moneyDelta > 0) moneyGained += e.moneyDelta;
    if (e.moneyDelta !== null && e.moneyDelta < 0) moneyLost += -e.moneyDelta;
    if (e.itemsValue !== null) {
      itemsValue += e.itemsValue;
      itemsKnown += 1;
    }
    if (e.nerveUsed !== null) {
      nerveUsed += e.nerveUsed;
      nerveKnown += 1;
    }
    if (e.jailSeconds !== null && e.jailSeconds > 0) {
      jailedCount += 1;
      totalJailSeconds += e.jailSeconds;
    }

    const key = e.crimeName ?? "Unknown crime";
    const row = byCrime.get(key) ?? byCrime.set(key, { attempts: 0, successes: 0, cash: 0, cashLost: 0, items: 0, itemsKnown: 0, nerve: 0, nerveKnown: 0 }).get(key)!;
    row.attempts += 1;
    if (e.success) row.successes += 1;
    if (e.moneyDelta !== null && e.moneyDelta > 0) row.cash += e.moneyDelta;
    if (e.moneyDelta !== null && e.moneyDelta < 0) row.cashLost += -e.moneyDelta;
    if (e.itemsValue !== null) {
      row.items += e.itemsValue;
      row.itemsKnown += 1;
    }
    if (e.nerveUsed !== null) {
      row.nerve += e.nerveUsed;
      row.nerveKnown += 1;
    }

    const day = Math.floor(e.occurredAt / 86_400) * 86_400;
    const d = byDay.get(day) ?? byDay.set(day, { attempts: 0, successes: 0, value: 0 }).get(day)!;
    d.attempts += 1;
    if (e.success) d.successes += 1;
    d.value += (e.moneyDelta ?? 0) + (e.itemsValue ?? 0);
  }

  const attempts = inRange.length;
  const days = Math.max(1, Math.ceil((to - from) / 86_400));
  const totalKnownValue = moneyGained - moneyLost + itemsValue;

  const rows: CrimeBreakdownRow[] = [...byCrime.entries()]
    .map(([crime, r]) => {
      const netValue = r.cash - r.cashLost + (r.itemsKnown > 0 ? r.items : 0);
      return {
        crime,
        attempts: r.attempts,
        successes: r.successes,
        successRate: r.attempts > 0 ? r.successes / r.attempts : null,
        cashGained: r.cash,
        cashLost: r.cashLost,
        estimatedItemsValue: r.itemsKnown > 0 ? r.items : null,
        netValue,
        nerveUsed: r.nerveKnown > 0 ? r.nerve : null,
        valuePerNerve: r.nerveKnown > 0 && r.nerve > 0 ? netValue / r.nerve : null,
      };
    })
    .sort((a, b) => b.attempts - a.attempts || b.netValue - a.netValue);

  return {
    attempts,
    successful,
    failed: attempts - successful,
    successRate: attempts > 0 ? successful / attempts : null,
    moneyGained,
    moneyLost,
    netCrimeCash: moneyGained - moneyLost,
    estimatedItemsValue: itemsKnown > 0 ? itemsValue : null,
    totalEstimatedValue: attempts > 0 ? totalKnownValue : null,
    nerveUsed: nerveKnown > 0 ? nerveUsed : null,
    valuePerNerve: nerveKnown > 0 && nerveUsed > 0 ? totalKnownValue / nerveUsed : null,
    jailedCount,
    totalJailSeconds,
    crimesPerDay: attempts / days,
    byCrime: rows,
    dailySeries: [...byDay.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ t, ...v })),
    provenance: "exact",
  };
}

/** Re-exported bucket helpers for chart axes consistency. */
export { bucketAxis, bucketStart };
