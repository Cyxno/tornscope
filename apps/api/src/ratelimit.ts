/**
 * Lightweight in-memory sliding-window rate limiter for sensitive endpoints.
 * Single-node V1: state lives in the API process. Keys are (bucket, subject)
 * so per-IP and per-user limits coexist without coupling. NOTE: state resets
 * on restart and is not shared across replicas — documented in
 * docs/HOSTED-SECURITY.md; restart-timed bursts are bounded by the small
 * per-route windows and the global per-IP limit.
 */
const buckets = new Map<string, number[]>();
const lastDenialLogAt = new Map<string, number>();

/** Drop fully-expired buckets occasionally so the map cannot grow forever. */
function prune(now: number): void {
  if (buckets.size < 5000) return;
  for (const [key, hits] of buckets) {
    const alive = hits.filter((t) => now - t < 3_600_000);
    if (alive.length === 0) buckets.delete(key);
    else buckets.set(key, alive);
  }
}

export function checkRateLimit(bucket: string, subject: string, limit: number, windowMs: number): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  prune(now);
  const key = `${bucket}:${subject}`;
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    const oldest = hits[0] ?? now;
    // Abuse telemetry (aggregate, throttled): one warn per key per 30s max —
    // operators see throttling pressure without per-request log spam.
    const lastWarn = lastDenialLogAt.get(key) ?? 0;
    if (now - lastWarn > 30_000) {
      lastDenialLogAt.set(key, now);
      // Dynamic import avoids a cycle: ratelimit must stay dependency-light.
      void import("./env.js").then(({ logger }) => {
        // Operator-side aggregate abuse telemetry (bucket + subject only).
        logger.warn({ bucket }, "rate limit engaged");
      }).catch(() => undefined);
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfterSeconds: 0 };
}

/**
 * Best-effort client IP for rate-limit identity.
 *
 * Always req.ip: Fastify computes it from the socket, honoring trustProxy —
 * when TRUST_PROXY is on, a trusted adjacent proxy's X-Forwarded-For chain
 * is resolved properly. Never read the raw header here: a direct client
 * could spoof a fresh X-Forwarded-For per request and get a clean bucket
 * every time.
 */
export function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  return req.ip ?? "unknown";
}
