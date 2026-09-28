import {
  buildDataFreshness,
  type SystemHealthResponse,
} from "@tornscope/shared";
import { getPrismaClient, getSyncStates } from "@tornscope/database";
import { checkReadiness, WORKER_HEARTBEAT_MAX_AGE_MS } from "./readiness.js";
import { getApiContext } from "../context.js";
import { resolveBuildIdentity } from "@tornscope/shared";
import { env } from "../env.js";
import type { SessionUser } from "../auth.js";

/**
 * System Health (2.0) — the /system page payload: service status, queue
 * state and per-domain data freshness.
 *
 * Secrets policy: the payload never carries connection strings, API keys,
 * VAPID material or topology details — statuses and timestamps only.
 * Everything derives from EXISTING health primitives (readiness probes,
 * worker heartbeat, SyncState bookkeeping) — no new probes, no Torn calls.
 */

/** Derive the Torn API service status from real sync outcomes (no probe). */
function tornApiStatus(states: Array<{ status: string; lastSuccessAt: Date | null; lastErrorKind: string | null }>, nowSec: number): { status: "ok" | "degraded" | "unknown"; lastSuccessAt: number | null; note: string } {
  const successes = states.map((s) => (s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null)).filter((t): t is number => t !== null);
  const lastSuccessAt = successes.length > 0 ? Math.max(...successes) : null;
  if (lastSuccessAt !== null && nowSec - lastSuccessAt <= 15 * 60) {
    return { status: "ok", lastSuccessAt, note: "A sync reached Torn within the last 15 minutes." };
  }
  const failing = states.filter((s) => s.status === "failed");
  if (failing.length > 0) {
    return { status: "degraded", lastSuccessAt, note: "Recent sync attempts are failing — retries are scheduled automatically." };
  }
  return { status: "unknown", lastSuccessAt, note: "No sync has run recently — nothing conclusive about Torn reachability." };
}

/** Build the full system-health payload for a profile. */
export async function getSystemHealth(user: SessionUser): Promise<SystemHealthResponse> {
  const db = getPrismaClient();
  const ctx = getApiContext();
  const nowSec = Math.floor(Date.now() / 1000);

  const { queueRedis } = await import("../redis.js");
  const [readiness, states, heartbeatAt] = await Promise.all([
    checkReadiness({
      dbPing: () => db.$queryRaw`SELECT 1`,
      withRedis: (fn) => queueRedis(ctx.syncQueue).then(fn),
    }),
    getSyncStates(db, user.id),
    queueRedis(ctx.syncQueue).then((r) => r.get("tornscope:worker:heartbeat")).catch(() => null),
  ]);

  let queue = { waiting: 0, active: 0, delayed: 0, failed: 0, oldestOutstandingAt: null as number | null };
  try {
    const counts = await ctx.syncQueue.getJobCounts("waiting", "active", "delayed", "failed");
    const [oldestWaiting, oldestDelayed] = await Promise.all([
      ctx.syncQueue.getJobs(["waiting"], 0, 0),
      ctx.syncQueue.getJobs(["delayed"], 0, 0),
    ]);
    const oldest = [...oldestWaiting, ...oldestDelayed].reduce<number | null>((acc, job) => {
      const ts = job.timestamp;
      return acc === null || ts < acc ? ts : acc;
    }, null);
    queue = {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      oldestOutstandingAt: oldest !== null ? Math.floor(oldest / 1000) : null,
    };
  } catch {
    // Queue introspection is best-effort — the page shows zeros + redis status.
  }

  const heartbeatAgeSeconds = heartbeatAt !== null && Number.isFinite(Number(heartbeatAt)) ? Math.max(0, nowSec - Math.floor(Number(heartbeatAt) / 1000)) : null;
  const failingResources = states
    .filter((s) => s.status === "failed" || s.status === "capability_denied")
    .map((s) => ({ resource: s.resource, state: s.status, lastErrorKind: s.lastErrorKind }));

  const identity = resolveBuildIdentity({ version: env.build.version, gitSha: process.env.GIT_SHA ?? "dev", environment: env.build.environment });

  return {
    generatedAt: Date.now(),
    services: {
      api: { status: "ok", version: identity.version, gitSha: identity.gitSha, environment: identity.environment },
      database: { status: readiness.checks.database },
      redis: { status: readiness.checks.redis },
      worker: {
        status: readiness.checks.worker,
        heartbeatAgeSeconds: heartbeatAgeSeconds !== null && heartbeatAgeSeconds > WORKER_HEARTBEAT_MAX_AGE_MS / 1000 ? heartbeatAgeSeconds : heartbeatAgeSeconds,
      },
      tornApi: tornApiStatus(
        states.map((s) => ({ status: s.status, lastSuccessAt: s.lastSuccessAt, lastErrorKind: s.lastErrorKind })),
        nowSec
      ),
    },
    sync: {
      running: states.some((s) => s.status === "running"),
      failingResources,
      lastSuccessAt: states.reduce<number | null>((acc, s) => {
        const t = s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null;
        return t !== null && (acc === null || t > acc) ? t : acc;
      }, null),
      queue,
    },
    freshness: buildDataFreshness(
      states.map((s) => ({
        resource: s.resource,
        status: s.status,
        lastAttemptAt: s.lastAttemptAt ? Math.floor(s.lastAttemptAt.getTime() / 1000) : null,
        lastSuccessAt: s.lastSuccessAt ? Math.floor(s.lastSuccessAt.getTime() / 1000) : null,
        nextRunAt: s.nextRunAt ? Math.floor(s.nextRunAt.getTime() / 1000) : null,
        frequencySeconds: s.frequencySeconds,
        errorCount: s.errorCount,
        lastErrorKind: s.lastErrorKind,
      })),
      nowSec
    ),
  };
}
