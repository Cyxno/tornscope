import { createHash } from "node:crypto";
import { DAY, type DemoDayKind } from "./constants.js";

/**
 * Bucketed deterministic randomness for demo generation.
 *
 * The full seed historically used ONE sequential PRNG — its state depended
 * on how much data previous calls generated, so an incremental top-up could
 * never reproduce a given day identically. Instead, every randomness consumer
 * derives its own generator from STABLE keys (family + UTC day bucket):
 *
 *     seed = sha256("tornscope-demo:" + label + ":" + keys…)
 *
 * Generating Sep 13→15 and Sep 14→15 therefore produce IDENTICAL Sep 14 rows
 * (Phase: determinism — no cross-run state, no history mutation on reruns).
 */

export function hashSeed(label: string, ...keys: Array<string | number>): number {
  const h = createHash("sha256").update(`tornscope-demo:${label}:${keys.join(":")}`).digest();
  return h.readUInt32LE(0);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoRng {
  next(): number;
  pick<T>(items: readonly T[]): T;
  between(min: number, max: number): number;
  weightedPick<T extends { weight: number }>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export function rngFor(label: string, ...keys: Array<string | number>): DemoRng {
  const rand = mulberry32(hashSeed(label, ...keys));
  return {
    next: rand,
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(rand() * items.length)]!;
    },
    between(min: number, max: number): number {
      return Math.floor(min + rand() * (max - min));
    },
    weightedPick<T extends { weight: number }>(items: readonly T[]): T {
      const total = items.reduce((s, i) => s + i.weight, 0);
      let roll = rand() * total;
      for (const item of items) {
        roll -= item.weight;
        if (roll <= 0) return item;
      }
      return items[items.length - 1]!;
    },
    chance(p: number): boolean {
      return rand() < p;
    },
  };
}

/** UTC day number (days since epoch) for a unix-second timestamp. */
export function utcDayNumber(sec: number): number {
  return Math.floor(sec / DAY);
}

export { DAY, HOUR } from "./constants.js";
export type { DemoDayKind } from "./constants.js";
