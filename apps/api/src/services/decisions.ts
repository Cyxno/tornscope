import {
  buildDecisionSignals,
  normalizeDecisionPrefs,
  reconcileLifecycle,
  SIGNAL_NEW_WINDOW_MS,
  type DecisionDomain,
  type DecisionPrefs,
  type DecisionFacts,
} from "@tornscope/analytics";
import type { DecisionSignalDto, DecisionSignalsResponse } from "@tornscope/shared";
import { gatherDecisionFacts, getPrismaClient } from "@tornscope/database";
import { Prisma } from "@tornscope/database";
import { TtlMap } from "@tornscope/shared";

/**
 * Decision Intelligence service (2.3.0).
 *
 * ONE bounded gather (indexed, capped reads over local history — zero Torn
 * calls), ONE pure engine pass, ONE short-lived cache per profile. Prefs and
 * signal lifecycle live in the existing AppSetting KV (JSON values) — no new
 * tables, no migration.
 */

const CACHE_TTL_MS = 60_000;
const cache = new TtlMap<DecisionSignalsResponse>({ ttlMs: CACHE_TTL_MS });
/**
 * Per-user single-flight: concurrent cold misses for the SAME profile share
 * one build instead of running N identical gathers (Overview strip + Insights
 * page can legitimately fire within the same cold window). Never blocks
 * other users.
 */
const inFlight = new Map<string, Promise<DecisionSignalsResponse>>();

const PREFS_KEY = "decision_prefs";
const LIFECYCLE_KEY = "decision_signal_state";

export async function getDecisionPrefs(userId: string): Promise<DecisionPrefs> {
  const db = getPrismaClient();
  const row = await db.appSetting.findUnique({ where: { userId_key: { userId, key: PREFS_KEY } } });
  return normalizeDecisionPrefs(row?.value);
}

export async function updateDecisionPrefs(
  userId: string,
  patch: Partial<Omit<DecisionPrefs, "domains">> & { domains?: Partial<Record<DecisionDomain, boolean>> }
): Promise<DecisionPrefs> {
  const current = await getDecisionPrefs(userId);
  const next = normalizeDecisionPrefs({ ...current, ...patch, domains: { ...current.domains, ...(patch.domains ?? {}) } });
  const db = getPrismaClient();
  await db.appSetting.upsert({
    where: { userId_key: { userId, key: PREFS_KEY } },
    create: { userId, key: PREFS_KEY, value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue },
  });
  cache.delete(userId);
  return next;
}

/** Recent income pace per covered day (trailing 7d) — goal pacing input. */
function recentIncomePace(
  facts: DecisionFacts
): { perDay: number | null; coveredDays: number } {
  const now = facts.now;
  const from = now - 7 * 86_400;
  const days = new Set<number>();
  let total = 0;
  for (const e of facts.money.events) {
    if (e.t < from || e.t > now || e.direction !== "income") continue;
    days.add(Math.floor(e.t / 86_400));
    total += Math.abs(e.amount);
  }
  const covered = days.size;
  return { perDay: covered > 0 ? total / covered : null, coveredDays: covered };
}

async function buildDecisions(userId: string): Promise<DecisionSignalsResponse> {
  const db = getPrismaClient();
  const nowSec = Math.floor(Date.now() / 1000);
  const prefs = await getDecisionPrefs(userId);

  const [facts, lifecycleRow] = await Promise.all([
    gatherDecisionFacts(db, userId, nowSec),
    db.appSetting.findUnique({ where: { userId_key: { userId, key: LIFECYCLE_KEY } } }),
  ]);

  const pace = recentIncomePace(facts);
  const goalFacts: DecisionFacts = { ...facts, goals: { ...facts.goals, networthPerDay: pace.perDay } };

  const result = buildDecisionSignals({
    facts: goalFacts,
    coverage: {
      money: { coveredDays: 0, events: facts.money.events.length, trackingSince: facts.money.trackingSince },
      drugs: { coveredDays: 0, events: facts.drugs.events.length, trackingSince: facts.drugs.trackingSince },
      travel: { coveredDays: 0, events: facts.travel.trips.length, trackingSince: facts.travel.trackingSince },
      energy: { coveredDays: 0, events: facts.energy.gym.length + facts.energy.refills.length, trackingSince: facts.energy.trackingSince },
    },
    prefs,
    networthPaceRecent: pace,
  });

  // Lifecycle: reconcile stable keys with the persisted state (AppSetting KV).
  const nowMs = Date.now();
  const state = (lifecycleRow?.value ?? {}) as Record<string, { firstSeenAt: number; lastSeenAt: number; resolvedAt: number | null }>;
  const currentKeysSet = new Set(result.signals.map((s) => s.id));
  const { nextState, newKeys } = reconcileLifecycle(
    result.signals.map((s) => s.id),
    state,
    nowMs
  );
  await db.appSetting.upsert({
    where: { userId_key: { userId, key: LIFECYCLE_KEY } },
    create: { userId, key: LIFECYCLE_KEY, value: nextState as unknown as Prisma.InputJsonValue },
    update: { value: nextState as unknown as Prisma.InputJsonValue },
  });

  const dtos: DecisionSignalDto[] = result.signals.map((s) => ({
    ...s,
    isNew: newKeys.has(s.id) || nowMs - (nextState[s.id]?.firstSeenAt ?? nowMs) < SIGNAL_NEW_WINDOW_MS,
    firstSeenAt: nextState[s.id]?.firstSeenAt ?? null,
  }));

  const covered = (ts: ReadonlyArray<{ t: number }>): number => new Set(ts.map((e) => Math.floor(e.t / 86_400))).size;
  const coverage: DecisionSignalsResponse["coverage"] = {
    money: { coveredDays: covered(facts.money.events), events: facts.money.events.length, trackingSince: facts.money.trackingSince },
    drugs: { coveredDays: covered(facts.drugs.events), events: facts.drugs.events.length, trackingSince: facts.drugs.trackingSince },
    travel: {
      coveredDays: covered(facts.travel.trips.map((t) => ({ t: t.departedAt }))),
      events: facts.travel.trips.length,
      trackingSince: facts.travel.trackingSince,
    },
    energy: {
      coveredDays: covered([...facts.energy.gym, ...facts.energy.refills]),
      events: facts.energy.gym.length + facts.energy.refills.length,
      trackingSince: facts.energy.trackingSince,
    },
    goals: { coveredDays: 0, events: facts.goals.paced.length, trackingSince: null },
  };

  const recentlyResolved = Object.entries(nextState)
    .filter(([id, e]) => e.resolvedAt !== null && !currentKeysSet.has(id) && nowMs - (e.resolvedAt ?? 0) < 7 * 86_400_000)
    .map(([id, e]) => ({ id, domain: id.split('.')[0] as DecisionDomain, resolvedAt: Math.floor((e.resolvedAt ?? 0) / 1000) }))
    .sort((a, b) => b.resolvedAt - a.resolvedAt)
    .slice(0, 8);

  return {
    generatedAt: nowSec,
    signals: dtos,
    overviewSignals: dtos.slice(0, prefs.maxOverviewSignals).map((s) => s.id),
    recentlyResolved,
    suppressedInsufficientData: result.suppressedInsufficientData,
    domainsSuppressed: result.domainsSuppressed,
    coverage,
    prefs,
  };
}

/** Cached decision signals for a profile. */
export async function getDecisions(userId: string): Promise<DecisionSignalsResponse> {
  const cached = cache.get(userId);
  if (cached) return cached;
  // Per-user single-flight: concurrent cold misses (Overview strip + Insights
  // page within the same cold window) share ONE build instead of running N
  // identical gathers. Never blocks other users.
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const build = buildDecisions(userId)
    .then((response) => {
      cache.set(userId, response);
      return response;
    })
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, build);
  return build;
}

export function invalidateDecisionsCache(userId: string): void {
  cache.delete(userId);
}

/** Domain list for validation. */
export const DECISION_DOMAINS: DecisionDomain[] = ["energy", "drugs", "travel", "money", "goals"];

