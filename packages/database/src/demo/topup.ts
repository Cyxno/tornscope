import { getPrismaClient } from "../client.js";
import { DEMO_USER_EMAIL } from "@tornscope/shared";
import { DAY, HOUR } from "./constants.js";
import { generateDemoHistory, type DemoContinuationState, type DemoGenerationResult } from "./generator.js";

/**
 * Incremental demo top-up (V1.0 demo freshness).
 *
 * The full seed (seed/demo.ts) is destructive and creates 180 days at once;
 * this module is the ROUTINE path: it preserves the demo profile and extends
 * the synthetic history toward now in a deterministic, idempotent way.
 *
 * Guarantees:
 *   - pure DB synthetic generation — the Torn API is never touched and no
 *     TornApiClient exists anywhere in this module tree (guard-tested);
 *   - never sends notifications (the worker never evaluates demo profiles
 *     anyway, and the top-up writes no notification rows at all);
 *   - every write is scoped to the demo user — real profiles are untouchable
 *     by construction (guard-tested);
 *   - self-throttled (6h), bounded catch-up (45 days), single-flight guard;
 *     failures log and retry at the next opportunity without advancing the
 *     watermark — partial progress stays consistent because every insert is
 *     idempotent by unique sourceRef.
 */

export const DEMO_TOPUP_WATERMARK_KEY = "demo_topup_watermark_at";
export const DEMO_TOPUP_MIN_INTERVAL_SEC = 6 * HOUR;
/** Maximum automatic catch-up window. Older than this, a manual full reseed
 *  is the honest recovery (surfaced in the result + logs, never silent). */
export const DEMO_TOPUP_MAX_CATCHUP_SEC = 45 * DAY;

export type TopUpStatus = "no-demo" | "current" | "done" | "in-flight" | "error" | "needs-seed";

export interface TopUpResult {
  status: TopUpStatus;
  fromSec?: number;
  toSec?: number;
  counts?: Record<string, number>;
  durationMs?: number;
  message?: string;
}

let inFlight = false;

/**
 * Self-throttled top-up entry point (Phase: scheduling). Called from the
 * worker's scheduler tick; cheap no-op when the demo is current (one user
 * read + one setting read). Injectable `nowSec` for deterministic tests.
 */
export async function maybeTopUpDemoData(nowSec: number = Math.floor(Date.now() / 1000), demoUserIdOverride?: string): Promise<TopUpResult> {
  const db = getPrismaClient();
  // Production path resolves the demo profile by its canonical email. Tests
  // pass an isolated userId override so they never touch the shared seeded
  // demo fixture other suites assert against.
  const demoUser = demoUserIdOverride
    ? await db.user.findUnique({ where: { id: demoUserIdOverride }, select: { id: true } })
    : await db.user.findFirst({ where: { email: DEMO_USER_EMAIL, isDemo: true }, select: { id: true } });
  if (!demoUser) return { status: "no-demo" };

  const watermark = await readWatermarkSec(db, demoUser.id);
  if (watermark !== null && nowSec - watermark < DEMO_TOPUP_MIN_INTERVAL_SEC) {
    return { status: "current" };
  }
  if (inFlight) return { status: "in-flight" };
  inFlight = true;
  try {
    return await runTopUp(db, demoUser.id, nowSec);
  } catch (err) {
    // Never crash the worker, never block real syncs: the watermark is not
    // advanced, so the next tick retries; idempotent sourceRefs make partial
    // progress recoverable.
    console.error(`[demo-topup] failed (will retry next tick): ${(err as Error).message}`, (err as Error).stack);
    return { status: "error", message: (err as Error).message };
  } finally {
    inFlight = false;
  }
}

async function runTopUp(db: ReturnType<typeof getPrismaClient>, userId: string, nowSec: number): Promise<TopUpResult> {
  const started = Date.now();
  const storedWatermark = await readWatermarkSec(db, userId);
  const latestDataSec = await latestHistoryWatermark(db, userId);
  if (latestDataSec === null) {
    return { status: "needs-seed", message: "no demo history found — run `pnpm demo:seed` for the full 180-day seed first" };
  }
  // The watermark is the authoritative cursor once it exists (it records the
  // top-up run, not the sparsest table's last event). Before the first ever
  // top-up, derive it from the actual newest data.
  const cursor = storedWatermark !== null ? Math.min(storedWatermark, latestDataSec) : latestDataSec;

  // Overlap one day to protect partial/interrupted previous runs; idempotent
  // sourceRefs make the overlap harmless (Phase: window + failure behavior).
  let fromSec = cursor - 1 * DAY;
  let truncated = false;
  if (nowSec - fromSec > DEMO_TOPUP_MAX_CATCHUP_SEC) {
    fromSec = nowSec - DEMO_TOPUP_MAX_CATCHUP_SEC;
    truncated = true;
  }

  // Continuation state must load AT the window start — loading the latest
    // snapshot would double-count the overlap stretch into new rows (the
    // walk would re-apply movements it already includes).
  const state = await loadContinuationState(db, userId, fromSec);
  // Continue the burst/snapshot grid from the loaded stat snapshots so
  // successive top-ups stay on ONE grid (a drifting grid would misalign
  // stat brackets and energy attribution).
  const result = await generateDemoHistory(db, {
    userId,
    fromSec,
    toSec: nowSec,
    state,
    gridOffset: state.statGridOffset,
    xanaxUnitPrice: state.xanaxUnitPrice,
  });

  await refreshDemoSyncHealth(db, userId, nowSec);
  await db.appSetting.upsert({
    where: { userId_key: { userId, key: DEMO_TOPUP_WATERMARK_KEY } },
    create: { userId, key: DEMO_TOPUP_WATERMARK_KEY, value: nowSec },
    update: { value: nowSec },
  });

  const durationMs = Date.now() - started;
  console.log(
    `[demo-topup] user=${userId} window=${new Date(fromSec * 1000).toISOString()} → ${new Date(nowSec * 1000).toISOString()} ` +
      `rows=${JSON.stringify(result.counts)} durationMs=${durationMs}` +
      (truncated ? ` (TRUNCATED to ${DEMO_TOPUP_MAX_CATCHUP_SEC / DAY}d — manual full reseed recommended)` : storedWatermark === null ? " (first top-up)" : "")
  );
  return { status: "done", fromSec, toSec: nowSec, counts: result.counts, durationMs };
}

/** Watermark epoch seconds, or null when never topped up. */
async function readWatermarkSec(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<number | null> {
  const setting = await db.appSetting.findUnique({ where: { userId_key: { userId, key: DEMO_TOPUP_WATERMARK_KEY } }, select: { value: true } });
  const raw = (setting?.value as { ts?: number } | number | null) ?? null;
  const ts = typeof raw === "number" ? raw : typeof raw === "object" && raw !== null ? raw.ts : undefined;
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : null;
}

/**
 * Newest historical timestamp across all event/snapshot families — the
 * pre-watermark cursor. Deliberately NOT used after the first top-up: a
 * single sparse family (e.g. rehab) could pull the window days back and
 * silently regenerate history.
 */
async function latestHistoryWatermark(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<number | null> {
  const [money, drug, rehab, travel, combat, crime, timeline, nw, stats, bars] = await Promise.all([
    db.moneyEvent.aggregate({ where: { userId }, _max: { occurredAt: true } }),
    db.drugEvent.aggregate({ where: { userId }, _max: { occurredAt: true } }),
    db.rehabEvent.aggregate({ where: { userId }, _max: { occurredAt: true } }),
    db.travelEvent.aggregate({ where: { userId }, _max: { departedAt: true } }),
    db.combatEvent.aggregate({ where: { userId }, _max: { occurredAt: true } }),
    db.crimeEvent.aggregate({ where: { userId }, _max: { occurredAt: true } }),
    db.timelineEvent.aggregate({ where: { userId }, _max: { occurredAt: true } }),
    db.networthSnapshot.aggregate({ where: { userId }, _max: { capturedAt: true } }),
    db.personalStatSnapshot.aggregate({ where: { userId }, _max: { capturedAt: true } }),
    db.barsSnapshot.aggregate({ where: { userId }, _max: { capturedAt: true } }),
  ]);
  const candidates = [money, drug, rehab, travel, combat, crime, timeline, nw, stats, bars]
    .map((r) => {
      const max = (r as { _max: { occurredAt?: Date | null; departedAt?: Date | null; capturedAt?: Date | null } })._max;
      return max.occurredAt ?? max.departedAt ?? max.capturedAt ?? null;
    })
    .filter((d): d is Date => d !== null)
    .map((d) => Math.floor(d.getTime() / 1000));
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/**
 * Continue the synthetic model FROM the latest existing demo state (Phase:
 * net worth consistency — never reset wealth to an arbitrary baseline).
 */
async function loadContinuationState(db: ReturnType<typeof getPrismaClient>, userId: string, atSec: number): Promise<DemoContinuationState & { xanaxUnitPrice: bigint; statGridOffset: number }> {
  const atDate = new Date(atSec * 1000);
  let statGridOffset = atSec % HOUR;
  const [lastNw, lastStats, lastBars, lastTravel, catalog] = await Promise.all([
    db.networthSnapshot.findFirst({ where: { userId, capturedAt: { lte: atDate } }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true, total: true, wallet: true } }),
    db.personalStatSnapshot.findFirst({ where: { userId, capturedAt: { lte: atDate } }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true, stats: true } }),
    db.barsSnapshot.findFirst({ where: { userId, capturedAt: { lte: atDate } }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true, energyCurrent: true, happyCurrent: true } }),
    db.travelEvent.findFirst({ where: { userId, departedAt: { lte: atDate } }, orderBy: { departedAt: "desc" }, select: { departedAt: true, returnedAt: true } }),
    db.tornItemCatalog.findUnique({ where: { itemId: 206 }, select: { marketPrice: true } }),
  ]);
  const statsJson = (lastStats?.stats ?? {}) as {
    battle_stats?: { strength?: number; defense?: number; speed?: number; dexterity?: number };
    drugs?: { xanax?: number; ecstasy?: number; overdoses?: number };
    other?: { refills?: { energy?: number }; awards?: number };
    items?: { used?: { candy?: number } };
  };
  const travelCursor = lastTravel
    ? Math.floor((lastTravel.returnedAt ?? new Date(lastTravel.departedAt.getTime() + DAY * 1000)).getTime() / 1000)
    : atSec - 10 * DAY;
  const result = {
    userId,
    nwBase: lastNw ? Number(lastNw.total) : 180_000_000,
    nwCapturedSec: lastNw ? Math.floor(lastNw.capturedAt.getTime() / 1000) : atSec - HOUR,
    wallet: lastNw ? Number(lastNw.wallet) : 25_000_000,
    stats: {
      str: statsJson.battle_stats?.strength ?? 12_400_000,
      def: statsJson.battle_stats?.defense ?? 9_850_000,
      spd: statsJson.battle_stats?.speed ?? 10_320_000,
      dex: statsJson.battle_stats?.dexterity ?? 8_640_000,
    },
    cum: {
      xanax: statsJson.drugs?.xanax ?? 347,
      ecstasy: statsJson.drugs?.ecstasy ?? 41,
      refills: statsJson.other?.refills?.energy ?? 137,
      candy: statsJson.items?.used?.candy ?? 2673,
      awards: statsJson.other?.awards ?? 172,
      overdoses: statsJson.drugs?.overdoses ?? 11,
    },
    energy: lastBars?.energyCurrent ?? 40,
    happy: lastBars?.happyCurrent ?? 1200,
    travelCursor,
    fromSec: lastNw ? Math.floor(lastNw.capturedAt.getTime() / 1000) : atSec,
    xanaxUnitPrice: catalog?.marketPrice != null ? BigInt(catalog.marketPrice) : 45_000n,
  };
  if (lastStats) statGridOffset = Math.floor(lastStats.capturedAt.getTime() / 1000) % HOUR;
  return { ...result, statGridOffset };
}

/**
 * Refresh the demo's synthetic SyncState health so the demo UI keeps showing
 * a healthy, current-looking dataset. DELIBERATE and documented (Phase: sync
 * state): this does NOT pretend a real Torn sync ran — the worker never
 * evaluates demo profiles, no Torn request is made, and the demo user has no
 * real credential. lastTimestamp marks the walk resources' synthetic coverage
 * as current so data-confidence reads the dataset as complete through now.
 */
async function refreshDemoSyncHealth(db: ReturnType<typeof getPrismaClient>, userId: string, nowSec: number): Promise<void> {
  const walkResources = new Set(["drugs", "rehab", "money_logs", "travel", "events", "attacks"]);
  for (const state of await db.syncState.findMany({ where: { userId }, select: { id: true, frequencySeconds: true, resource: true } })) {
    await db.syncState.update({
      where: { id: state.id },
      data: {
        status: "idle",
        lastSuccessAt: new Date(nowSec * 1000),
        lastAttemptAt: new Date(nowSec * 1000),
        lastCompletedAt: new Date(nowSec * 1000),
        ...(walkResources.has(state.resource) ? { stopReason: "source_exhausted" as const, lastTimestamp: BigInt(nowSec) } : {}),
        nextRunAt: new Date((nowSec + state.frequencySeconds) * 1000),
      },
    });
  }
}

export type { DemoGenerationResult };
