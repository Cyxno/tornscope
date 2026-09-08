/**
 * Readiness probes for /api/ready. Pure orchestration, no Fastify: all
 * side-effecting checks are injected, so the status logic is unit-testable
 * without a live stack.
 *
 * Never touches the Torn API; the returned checks carry no credentials,
 * connection strings or topology details.
 *
 * Migration state is intentionally not probed directly: in every supported
 * deployment (Docker Compose, CI) the API process only starts after the
 * `migrate` service has completed `prisma migrate deploy`, so a reachable
 * database plus a live worker implies an up-to-date schema.
 */

/** A worker heartbeat older than this (the key TTL is 180s) counts as stale. */
export const WORKER_HEARTBEAT_MAX_AGE_MS = 180_000;

/** Redis key the worker touches on every scheduler tick (apps/worker). */
export const WORKER_HEARTBEAT_KEY = "tornscope:worker:heartbeat";

export interface ReadinessChecks {
  database: string;
  redis: string;
  worker: string;
}

/** Minimal Redis surface used by the probe (mirrors RedisLike). */
export interface ReadinessRedis {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
}

export interface ReadinessDeps {
  /** Must reject when PostgreSQL is unreachable. */
  dbPing: () => Promise<unknown>;
  /** Runs fn with the queue Redis connection (connection itself may fail/hang). */
  withRedis: <T>(fn: (redis: ReadinessRedis) => T) => Promise<T>;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

/** Runs every dependency probe and reports an unambiguous ready/not_ready verdict. */
export async function checkReadiness(
  deps: ReadinessDeps
): Promise<{ checks: ReadinessChecks; ready: boolean }> {
  const now = deps.now ?? Date.now;
  const checks: ReadinessChecks = { database: "unreachable", redis: "unreachable", worker: "unreachable" };
  let ready = true;

  try {
    await deps.dbPing();
    checks.database = "ok";
  } catch {
    ready = false;
  }

  // Redis and the worker heartbeat share a failure domain (the queue
  // connection), so one guard covers both.
  try {
    const redis = await withTimeout(deps.withRedis((r) => r), 5000);
    const pong = await withTimeout(redis.ping(), 3000);
    checks.redis = pong === "PONG" ? "ok" : "unreachable";
    if (pong !== "PONG") ready = false;

    const beat = await withTimeout(redis.get(WORKER_HEARTBEAT_KEY), 2000);
    const recent = beat !== null && Number.isFinite(Number(beat)) && now() - Number(beat) < WORKER_HEARTBEAT_MAX_AGE_MS;
    checks.worker = recent ? "ok" : "stale";
    if (!recent) ready = false;
  } catch {
    checks.redis = "unreachable";
    checks.worker = "unreachable";
    ready = false;
  }

  return { checks, ready };
}
