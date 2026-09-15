/**
 * Centralized client-side rate limiter for outgoing Torn API requests.
 *
 * Torn allows roughly 100 requests per minute PER USER (across all keys)
 * and 1000/min per IP. We enforce a minimum spacing between requests
 * (default 700ms ≈ 85/min) which leaves headroom under the documented
 * limit, and Torn code-5 responses are handled with backoff as a second
 * line of defense.
 *
 * V1 ARCHITECTURE DECISION (explicit, do not re-litigate silently): the
 * limiter is PROCESS-LOCAL. The API and the worker each serialize their
 * whole outbound Torn traffic through their own instance, so neither
 * process knows about the other's pacing. This is accepted for the V1
 * single-node deployment because the bound still holds: the worker's
 * global queue caps its entire contribution at ~85/min (for ALL users),
 * and the API's per-user live traffic (Today polling ≈ 14/min, occasional
 * validations) is small — worst-case alignment lands a single user around
 * ~100/min, where Torn code-5 + backoff absorbs the transient. Scaling out
 * (multiple workers/replicas) invalidates this arithmetic: raise
 * TORN_API_MIN_REQUEST_INTERVAL_MS so the PER-PROCESS budgets still sum
 * under the per-user limit, or move to a shared (Redis) limiter. See
 * docs/HOSTED-SECURITY.md "Outbound Torn rate limiting".
 */
export class RateLimiter {
  private queueTail: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  get intervalMs(): number {
    return this.minIntervalMs;
  }

  /**
   * Serialize a request through the limiter. Returns the waiter's result and
   * guarantees spacing of at least minIntervalMs between consecutive starts.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const execution = this.queueTail.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestAt;
      if (this.lastRequestAt > 0 && elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }
      this.lastRequestAt = Date.now();
      return fn();
    });
    // Keep the chain alive even if a request rejects.
    this.queueTail = execution.then(
      () => undefined,
      () => undefined
    );
    return execution;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
