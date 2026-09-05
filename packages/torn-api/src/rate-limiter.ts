/**
 * Centralized client-side rate limiter for outgoing Torn API requests.
 *
 * Torn allows roughly 100 requests per minute per user across all keys and
 * 1000/min per IP. We enforce a minimum spacing between requests (default
 * 700ms ~= 85/min) which leaves headroom under the documented limit. The
 * limiter is process-local; multiple worker processes should each use
 * conservative spacing (and Torn's code-5 responses are also handled with
 * backoff as a second line of defense).
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
