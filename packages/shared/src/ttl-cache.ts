/**
 * Minimal TTL map for long-lived single-node processes (V1.0 hardening).
 *
 * The API and worker keep small in-memory caches keyed by user/credential/IP.
 * Plain Maps retain EXPIRED entries forever when the key never returns, so
 * every module-level cache with a TTL uses this helper instead:
 *
 *   - lazy, amortized cleanup: a sweep runs at most once per `sweepEvery`
 *     set() calls (never a global timer that can itself leak);
 *   - a hard `maxEntries` bound: expired entries go first, then oldest
 *     inserts (Map preserves insertion order) — memory stays bounded even
 *     under key-flood conditions;
 *   - fully deterministic: inject `now` in tests, no real time needed.
 *
 * Deliberately NOT a caching framework: no LRU weighting, no async loaders,
 * no persistence — the call sites keep their own semantics.
 */
export interface TtlMapOptions {
  /** Entry lifetime in ms. A set() refreshes the entry's expiry. */
  ttlMs: number;
  /** Hard entry ceiling (default 10_000). */
  maxEntries?: number;
  /** Sweep at most once per N set() calls (default 32). */
  sweepEvery?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface TtlEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlMap<V> {
  private readonly entries = new Map<string, TtlEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly sweepEvery: number;
  private readonly now: () => number;
  private setsSinceSweep = 0;

  constructor(options: TtlMapOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.sweepEvery = options.sweepEvery ?? 32;
    // Dynamic lookup (not a captured reference) so clock patching in tests
    // and any future clock injection stay visible to every call.
    this.now = options.now ?? (() => Date.now());
  }

  /** Live value for `key`, or undefined. Expired entries are dropped on read. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Insert/refresh an entry, refreshing its TTL. Occasionally sweeps. */
  set(key: string, value: V): void {
    const now = this.now();
    if (++this.setsSinceSweep >= this.sweepEvery) {
      this.setsSinceSweep = 0;
      this.sweep(now);
    }
    // Refreshing an existing entry must keep its original insertion slot
    // (Map.set on an existing key does exactly that), so "oldest" below
    // really means oldest insertion.
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    this.enforceBound(now);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Live (non-expired) entry count. */
  get size(): number {
    return this.liveKeys(this.now()).length;
  }

  /** Raw retained entry count including not-yet-swept expired entries. */
  get retainedSize(): number {
    return this.entries.size;
  }

  /**
   * Remove every expired entry. Cheap and amortized via set(); safe to call
   * directly (bounded by map size). Returns the number of entries removed.
   */
  sweep(now: number = this.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Hard ceiling: after expiring what we can, evict oldest inserts. */
  private enforceBound(now: number): void {
    let excess = this.entries.size - this.maxEntries;
    if (excess <= 0) return;
    for (const [key, entry] of this.entries) {
      if (excess === 0) break;
      if (entry.expiresAt <= now) {
        this.entries.delete(key); // expired first
        excess--;
      }
    }
    for (const key of this.entries.keys()) {
      if (excess === 0) break;
      this.entries.delete(key); // then oldest inserts
      excess--;
    }
  }

  private liveKeys(now: number): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) out.push(key);
    }
    return out;
  }
}
