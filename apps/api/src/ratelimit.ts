/**
 * Lightweight in-memory sliding-window rate limiter for sensitive endpoints.
 * Single-node V1: state lives in the API process. Keys are (bucket, subject)
 * so per-IP and per-user limits coexist without coupling.
 */
const buckets = new Map<string, number[]>();

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
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000)) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfterSeconds: 0 };
}

/** Best-effort client IP (behind the reverse proxy, x-forwarded-for first). */
export function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.ip ?? "unknown";
}
