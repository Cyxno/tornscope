import {
  alertTrigger,
  alertQuietEndSec,
  cooldownKindsFromConfig,
  diffAlertTimers,
  diffSyncHealth,
  evaluateBarCappedDuration,
  evaluateDrugWindow,
  evaluateGoalMilestone,
  evaluateImminentTimer,
  evaluateNetworthDrawdown,
  evaluateNetworthDrop,
  evaluateOverdoseSpike,
  evaluateTrainingStagnation,
  formatMoney,
  isAlertQuietNow,
  NETWORTH_CURRENT_MAX_AGE_SECONDS,
  NETWORTH_DRAWDOWN_BASELINE_SECONDS,
  networthDrawdownEpisodeKey,
  networthEpisodeKey,
  parseAlertQuietHours,
  parseAlertRuleState,
  sendDiscordWebhook,
  syncIncidentSignature,
  type AlertDraft,
  type AlertQuietHours,
  type AlertRuleState,
  type AlertTimerState,
  type GoalMetricId,
  type NetworthPoint,
} from "@tornscope/shared";
import {
  extractBattlestats,
  goalCurrentValue,
  liquidWealth,
  type GoalFacts,
} from "@tornscope/analytics";
import { GOAL_MILESTONE_FRACTIONS } from "@tornscope/analytics";
import { getPrismaClient } from "@tornscope/database";
import { RESOURCE_LABELS, type LiveTimerState } from "@tornscope/shared";
import { env, logger } from "../env.js";
import { fetchLiveTimers } from "../notifications/engine.js";
import { dispatchDueAlertDeliveries } from "./dispatch.js";

/**
 * Proactive Alerts engine (2.9.0) — evaluates enabled AlertRules on the
 * EXISTING scheduler tick (no extra worker container, no extra queue):
 *
 *   scheduler tick (60s)
 *     → evaluateAlerts()        (self-throttled, demo profiles skipped)
 *         per account: load enabled rules → build state ONCE
 *           (one live Torn call shared with the push engine when a rule
 *            needs it; stored data otherwise)
 *         → per-rule evaluator (pure, shared/alerts.ts) → drafts
 *         → commitAlert(): cooldown + quiet-hours policy, ONE transaction
 *           per logical alert (in-app delivery + channel fan-out rows),
 *           idempotent via the (userId, dedupeKey) unique constraint
 *     → dispatchDueAlertDeliveries()  (Discord, bounded retries — dispatch.ts)
 *
 * DOWNDAMAGE / BACKFILL PROTECTION (documented behavior):
 * - The FIRST observation of a rule only establishes the baseline.
 * - A previous observation older than the trigger's max gap (12h) is
 *   re-baselined silently — no transition is ever fabricated across a
 *   downtime window, imported history or a long sync outage.
 * - Failed live fetches keep the previous baseline untouched.
 * - Operational sync-health transitions still evaluate during downtime:
 *   NEW failures and recoveries alert normally; the set difference makes
 *   pre-existing failures silent.
 * - ALERTS_ENABLED=false stops evaluation AND dispatch; pending deliveries
 *   are retained, never deleted.
 */

const MIN_EVALUATE_SECONDS = 60;
/** Live re-fetch cadence when no tracked timer is near its end. */
const IDLE_RECHECK_SECONDS = 300;
/** Extended-downtime bound for OC transition detection (spec 3.1 / 7.1). */
const OC_MAX_OBSERVATION_GAP_SECONDS = 12 * 3600;
/** "No longer updating" threshold — same contract as the push system producer. */
const SYNC_DEGRADED_MIN_ERRORS = 2;

let lastRunAt = 0;

/** Live-fetch throttle per account (in-memory; a worker restart costs one
 *  extra fetch, nothing else). nextEligibleAt mirrors the push engine's
 *  nextEligibleAt so a tracked timer is never missed by more than its grace. */
const liveFetchState = new Map<string, { fetchedAt: number; nextEligibleAt: number }>();

/** Test hook: reset in-memory throttles between tests. */
export function resetAlertEngineStateForTests(): void {
  lastRunAt = 0;
  liveFetchState.clear();
}

/* -------------------------------------------------------------------------- */
/* Entry point (scheduler tick)                                               */
/* -------------------------------------------------------------------------- */

export async function evaluateAlerts(opts: { liveFetch?: typeof fetchLiveTimers; sender?: typeof sendDiscordWebhook } = {}): Promise<void> {
  if (!env.alerts.enabled) return;
  const now = Date.now();
  if (now - lastRunAt < MIN_EVALUATE_SECONDS * 1000) return;
  lastRunAt = now;

  const db = getPrismaClient();
  const accounts = await db.alertRule.findMany({
    where: { enabled: true },
    select: { userId: true },
    distinct: ["userId"],
  });
  let failed = 0;
  for (const { userId } of accounts) {
    const user = await db.user.findUnique({ where: { id: userId }, select: { isDemo: true } });
    // Demo profiles are never evaluated and never dispatch (defense in depth
    // alongside the fake demo channel targets).
    if (!user || user.isDemo) continue;
    try {
      await evaluateUserAlerts(userId, opts);
    } catch (err) {
      failed += 1;
      logger.warn({ userId, err: (err as Error).message }, "alert evaluation failed");
    }
  }
  await dispatchDueAlertDeliveries({ sender: opts.sender }).catch((err: Error) => {
    logger.warn({ err: err.message }, "alert dispatch pass failed");
  });
  if (accounts.length > 0) {
    logger.debug({ accounts: accounts.length, failed }, "alert evaluation tick complete");
  }
}

/* -------------------------------------------------------------------------- */
/* Per-account evaluation                                                     */
/* -------------------------------------------------------------------------- */

interface StoredInputs {
  /** Recruiting OCs with a readyAt inside the previous observation window. */
  ocsReady: Array<{ ocId: number; name: string; readyAtSec: number }> | null;
  /** Recruiting OCs whose readyAt lies inside the imminent horizon (2.10.0). */
  ocsImminent: Array<{ ocId: number; name: string; readyAtSec: number }> | null;
  networth: { baseline: NetworthPoint | null; current: NetworthPoint | null } | null;
  /** Drawdown inputs (2.10.0): baseline closest to exactly 7 days ago. */
  drawdown: { baseline: NetworthPoint | null; current: NetworthPoint | null } | null;
  syncFailing: string[] | null;
  /** SyncState.updatedAt per resource — the incident stamp for dedupe keys. */
  syncStampByResource: Map<string, number> | null;
  /** Drug-event timestamps (sec), fetched once per account when needed. */
  drugEventTimes: number[] | null;
  /** Overdose timestamps (sec) over the baseline period when needed. */
  overdoseTimes: number[] | null;
  /** Latest stored happy bar (bar_capped for happy is stored-history only). */
  latestBars: { capturedAtSec: number; happyCurrent: number; happyMaximum: number } | null;
  /** Latest + comparison battlestat totals (training_stagnation). */
  latestStats: { total: number; atSec: number } | null;
  comparisonStats: { total: number; atSec: number } | null;
  /** Active goals + latest stored value per metric (goal_milestone). */
  activeGoals: Array<{ id: string; metric: GoalMetricId; target: number }> | null;
  goalFacts: GoalFacts | null;
}

async function evaluateUserAlerts(userId: string, opts: { liveFetch?: typeof fetchLiveTimers }): Promise<void> {
  const db = getPrismaClient();
  const rules = await db.alertRule.findMany({ where: { userId, enabled: true } });
  if (rules.length === 0) return;
  const nowSec = Math.floor(Date.now() / 1000);

  const liveRules = rules.filter((r) => alertTrigger(r.triggerType)?.needsLiveFetch === true);
  let live: AlertTimerState | null = null;
  if (liveRules.length > 0 && liveFetchDue(userId, nowSec)) {
    const fetcher = opts.liveFetch ?? fetchLiveTimers;
    const fetched: LiveTimerState | null = await fetcher(userId, env.tornBaseUrl, env.tornMinRequestIntervalMs);
    if (fetched !== null) {
      live = fetched;
      const nextEligible = nextLiveEligibleAt(fetched, nowSec);
      liveFetchState.set(userId, { fetchedAt: nowSec, nextEligibleAt: nextEligible });
    } else {
      // Fetch failed: back off briefly; baselines stay untouched.
      liveFetchState.set(userId, { fetchedAt: nowSec, nextEligibleAt: nowSec + IDLE_RECHECK_SECONDS });
    }
  }

  const stored: StoredInputs = {
    ocsReady: null,
    ocsImminent: null,
    networth: null,
    drawdown: null,
    syncFailing: null,
    syncStampByResource: null,
    drugEventTimes: null,
    overdoseTimes: null,
    latestBars: null,
    latestStats: null,
    comparisonStats: null,
    activeGoals: null,
    goalFacts: null,
  };
  const channels = await db.alertChannel.findMany({
    where: { userId, enabled: true },
    select: { id: true },
  });

  for (const rule of rules) {
    try {
      await evaluateRule(db, userId, rule, { nowSec, live, stored, channelIds: channels.map((c) => c.id) });
    } catch (err) {
      logger.warn({ userId, ruleId: rule.id, triggerType: rule.triggerType, err: (err as Error).message }, "rule evaluation failed");
    }
  }
}

/** True when a live observation is due: idle cadence passed, or a previously
 *  tracked timer end has come within reach so the transition is not missed. */
function liveFetchDue(userId: string, nowSec: number): boolean {
  const state = liveFetchState.get(userId);
  if (!state) return true;
  return nowSec >= state.nextEligibleAt;
}

function nextLiveEligibleAt(timers: AlertTimerState, nowSec: number): number {
  let next: number | null = null;
  const ends = [
    timers.cooldownDrugEndsAt,
    timers.cooldownBoosterEndsAt,
    timers.cooldownMedicalEndsAt,
    timers.travelLandsAt,
    timers.educationEndsAt,
    timers.bankMaturesAt,
    timers.energyFullAt,
    timers.nerveFullAt,
  ];
  for (const end of ends) {
    if (typeof end === "number" && end > nowSec && (next === null || end < next)) next = end;
  }
  const idle = nowSec + IDLE_RECHECK_SECONDS;
  return next !== null ? Math.min(next + 120, idle) : idle;
}

/* -------------------------------------------------------------------------- */
/* Per-rule evaluators (explicit functions — no scattered conditionals)       */
/* -------------------------------------------------------------------------- */

interface RuleEvaluation {
  drafts: AlertDraft[];
  /** New lastState to persist (merged over the previous), or null to keep. */
  nextState: AlertRuleState | null;
  /** Whether the rule needs the live observation; skips silently otherwise. */
  needsLive: boolean;
}

/** Shared timer-transition evaluator: the trigger declares WHICH kinds it
 *  watches; drafts copy the trigger's own identity and copy. */
type TimerKind = "cooldown_drug" | "cooldown_booster" | "cooldown_medical" | "travel" | "education" | "bank";

function evaluateTimerTransitions(
  previous: AlertRuleState | null,
  live: AlertTimerState | null,
  kinds: ReadonlyArray<TimerKind>,
  triggerType: AlertDraft["triggerType"],
  nowSec: number,
  maxGapSeconds: number,
  copy: (event: { kind: TimerKind; endSec: number; label: string }) => { title: string; message: string },
  provenance: AlertDraft["provenance"]
): RuleEvaluation {
  if (live === null) return { drafts: [], nextState: null, needsLive: true };
  if (previous === null || nowSec - previous.observedAt > maxGapSeconds) {
    return { drafts: [], nextState: { observedAt: nowSec, timers: live }, needsLive: true };
  }
  const events = diffAlertTimers(
    { observedAt: previous.observedAt, timers: previous.timers ?? {} },
    live,
    nowSec,
    kinds,
    maxGapSeconds
  );
  const drafts: AlertDraft[] = events.map((e) => {
    const c = copy(e);
    return {
      triggerType,
      dedupeKey: `${triggerType}:${e.kind}:${e.endSec}`,
      occurredAt: e.endSec,
      title: c.title,
      message: c.message,
      provenance,
      clickPath: alertTrigger(triggerType)?.clickPath ?? "/today",
    };
  });
  return { drafts, nextState: { observedAt: nowSec, timers: live }, needsLive: true };
}

const LIVE_TIMER_PROVENANCE: AlertDraft["provenance"] = {
  confidence: "exact",
  sources: ["Torn /user live timers"],
};

function evaluateCooldownReady(
  previous: AlertRuleState | null,
  live: AlertTimerState | null,
  config: Record<string, unknown>,
  nowSec: number,
  maxGapSeconds: number
): RuleEvaluation {
  const kinds = cooldownKindsFromConfig(config).map((k) => `cooldown_${k}` as TimerKind);
  return evaluateTimerTransitions(previous, live, kinds, "cooldown_ready", nowSec, maxGapSeconds, () => ({
    title: "Cooldown ready",
    message: "The cooldown finished — you can use it again.",
  }), LIVE_TIMER_PROVENANCE);}

function evaluateTravelLanded(
  previous: AlertRuleState | null,
  live: AlertTimerState | null,
  _config: Record<string, unknown>,
  nowSec: number,
  maxGapSeconds: number
): RuleEvaluation {
  return evaluateTimerTransitions(previous, live, ["travel"], "travel_landed", nowSec, maxGapSeconds, () => ({
    title: "Travel landed",
    message: "Your flight landed — welcome home.",
  }), LIVE_TIMER_PROVENANCE);}

function evaluateEducationDone(
  previous: AlertRuleState | null,
  live: AlertTimerState | null,
  _config: Record<string, unknown>,
  nowSec: number,
  maxGapSeconds: number
): RuleEvaluation {
  return evaluateTimerTransitions(previous, live, ["education"], "education_done", nowSec, maxGapSeconds, () => ({
    title: "Education completed",
    message: "Your education course has finished.",
  }), LIVE_TIMER_PROVENANCE);
}

function evaluateBankMatured(
  previous: AlertRuleState | null,
  live: AlertTimerState | null,
  _config: Record<string, unknown>,
  nowSec: number,
  maxGapSeconds: number
): RuleEvaluation {
  return evaluateTimerTransitions(previous, live, ["bank"], "bank_matured", nowSec, maxGapSeconds, () => ({
    title: "Bank investment matured",
    message: "A city-bank investment matured — collect your funds.",
  }), LIVE_TIMER_PROVENANCE);}

async function evaluateOcReady(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  nowSec: number,
  maxGapSeconds: number
): Promise<RuleEvaluation> {
  if (previous === null || nowSec - previous.observedAt > maxGapSeconds) {
    return { drafts: [], nextState: { observedAt: nowSec }, needsLive: false };
  }
  if (stored.ocsReady === null) {
    const account = await db.tornAccount.findUnique({ where: { userId }, select: { tornId: true } });
    if (account?.tornId == null) return { drafts: [], nextState: { observedAt: nowSec }, needsLive: false };
    // OCs whose readyAt passed SINCE the previous observation: a genuine
    // became-available transition, never a historical backlog.
    const rows = await db.organizedCrime.findMany({
      where: {
        userId,
        status: "recruiting",
        readyAt: { not: null, lte: new Date(nowSec * 1000), gt: new Date(previous.observedAt * 1000) },
      },
      select: { ocId: true, name: true, readyAt: true, slots: true },
    });
    const slotsIncludeUser = (slots: unknown): boolean => {
      if (!Array.isArray(slots)) return false;
      return (slots as Array<{ user?: { id?: number } | null }>).some((s) => s.user?.id === account.tornId);
    };
    stored.ocsReady = rows
      .filter((r) => r.readyAt !== null && slotsIncludeUser(r.slots))
      .map((r) => ({ ocId: r.ocId, name: r.name, readyAtSec: Math.floor(r.readyAt!.getTime() / 1000) }));
  }
  const drafts: AlertDraft[] = stored.ocsReady.map((oc) => ({
    triggerType: "oc_ready",
    dedupeKey: `oc:ready:${oc.ocId}:${oc.readyAtSec}`,
    occurredAt: oc.readyAtSec,
    title: `OC ready: ${oc.name}`,
    message: "Your organized crime is ready to initiate.",
    payload: { ocId: oc.ocId, name: oc.name, readyAtSec: oc.readyAtSec },
    provenance: { confidence: "exact", sources: ["OrganizedCrime"] },
    clickPath: "/faction",
  }));
  return { drafts, nextState: { observedAt: nowSec }, needsLive: false };
}

async function evaluateNetWorthDrop(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  ruleId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  config: { pct?: number; window_hours?: number },
  nowSec: number
): Promise<RuleEvaluation> {
  const windowHours = typeof config.window_hours === "number" ? config.window_hours : 24;
  if (stored.networth === null) {
    const boundarySec = nowSec - windowHours * 3600;
    const [baselineRow, currentRow] = await Promise.all([
      db.networthSnapshot.findFirst({
        where: { userId, capturedAt: { lte: new Date(boundarySec * 1000) } },
        orderBy: { capturedAt: "desc" },
        select: { id: true, capturedAt: true, total: true },
      }),
      db.networthSnapshot.findFirst({
        where: { userId },
        orderBy: { capturedAt: "desc" },
        select: { id: true, capturedAt: true, total: true },
      }),
    ]);
    const toPoint = (row: { id: string; capturedAt: Date; total: bigint } | null): NetworthPoint | null =>
      row ? { id: row.id, capturedAt: Math.floor(row.capturedAt.getTime() / 1000), total: row.total.toString() } : null;
    const baseline = toPoint(baselineRow);
    const current = toPoint(currentRow);
    stored.networth = {
      // A single snapshot in the window is not a measurable drop.
      baseline: baseline !== null && baseline.id === current?.id ? null : baseline,
      current: current !== null && nowSec - current.capturedAt <= NETWORTH_CURRENT_MAX_AGE_SECONDS ? current : null,
    };
  }
  const { baseline, current } = stored.networth;
  const openEpisodeKey = previous?.openEpisode?.baselineId ?? null;
  const result = evaluateNetworthDrop(baseline, current, config, nowSec, openEpisodeKey);

  if (previous === null) {
    // Initial activation: baseline only, never an alert.
    return { drafts: [], nextState: { observedAt: nowSec, openEpisode: null }, needsLive: false };
  }
  if (!result.eligible) {
    // RECOVERY (audit F2): the episode closes ONLY on a valid comparison
    // (reason undefined) that shows the value back above the threshold.
    // Data-quality failures — missing/stale snapshots, no usable baseline in
    // the window — keep the episode open: a temporary sync outage must never
    // re-alert the same decline when fresh data returns.
    if (result.reason === undefined) {
      return {
        drafts: [],
        nextState: { observedAt: previous.observedAt, openEpisode: null },
        needsLive: false,
      };
    }
    // Data-quality failure or an already-open episode: preserve the state.
    return {
      drafts: [],
      nextState: { observedAt: previous.observedAt, openEpisode: previous.openEpisode ?? null },
      needsLive: false,
    };
  }
  const episodeKey = networthEpisodeKey(baseline!.id);
  const dropPct = Math.round(result.dropPct * 10) / 10;
  const draft: AlertDraft = {
    triggerType: "net_worth_drop",
    dedupeKey: `nwdrop:${baseline!.id}:${current!.id}`,
    occurredAt: current!.capturedAt,
    title: "Net worth dropped",
    message: `Net worth fell ${dropPct}% over the last ${windowHours}h — ${formatMoney(Number(result.baselineTotal))} → ${formatMoney(Number(result.currentTotal))}.`,
    payload: {
      dropPct,
      pct: typeof config.pct === "number" ? config.pct : 5,
      windowHours,
      baselineTotal: result.baselineTotal,
      currentTotal: result.currentTotal,
      baselineAtSec: baseline!.capturedAt,
      currentAtSec: current!.capturedAt,
    },
    provenance: {
      confidence: "exact",
      sources: ["NetworthSnapshot"],
      window: { fromSec: baseline!.capturedAt, toSec: current!.capturedAt },
    },
    clickPath: "/money",
  };
  return { drafts: [draft], nextState: { observedAt: previous.observedAt, openEpisode: { baselineId: episodeKey } }, needsLive: false };
}

async function evaluateSyncHealth(
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  direction: "sync_failure" | "sync_recovery",
  nowSec: number
): Promise<RuleEvaluation> {
  if (stored.syncFailing === null) {
    const db = getPrismaClient();
    const states = await db.syncState.findMany({
      where: { userId },
      select: { resource: true, status: true, errorCount: true, lastErrorKind: true, updatedAt: true },
    });
    const CAPABILITY_KINDS = new Set(["access_denied", "key_invalid", "key_paused"]);
    const capabilitySet = new Set(
      states
        .filter((s) => s.status === "capability_denied" || (s.lastErrorKind !== null && CAPABILITY_KINDS.has(s.lastErrorKind)))
        .map((s) => s.resource)
    );
    stored.syncFailing = states
      .filter((s) => s.status === "failed" && s.errorCount >= SYNC_DEGRADED_MIN_ERRORS && !capabilitySet.has(s.resource))
      .map((s) => s.resource)
      .sort();
    // Per-resource incident stamp (audit F1): SyncState.updatedAt is written
    // by every sync attempt, so a NEW incident of the SAME resource set gets
    // a fresh stamp and can alert again — while repeated evaluations of one
    // incident and crash replays stay stable (a down worker runs no syncs,
    // so updatedAt cannot move between the alert commit and the replay).
    // Same mechanism as the push system producer's capability_lost stamp.
    stored.syncStampByResource = new Map(
      states.map((s) => [s.resource, s.updatedAt.getTime()])
    );
  }
  const prevFailing = previous?.failing ?? null;
  const { failures, recoveries } = diffSyncHealth(prevFailing, stored.syncFailing);
  const nextState: AlertRuleState = { observedAt: nowSec, failing: stored.syncFailing };
  if (prevFailing === null) return { drafts: [], nextState, needsLive: false }; // baseline

  // The stamp is the LATEST updatedAt among the affected resources — the
  // incident's own identity, not the evaluation clock (never Date.now():
  // every tick would mint a new alert).
  const stampFor = (resources: string[]): number =>
    resources.reduce((acc, r) => Math.max(acc, stored.syncStampByResource?.get(r) ?? 0), 0);

  if (direction === "sync_failure") {
    if (failures.length === 0) return { drafts: [], nextState, needsLive: false };
    const label = (r: string) => RESOURCE_LABELS[r as keyof typeof RESOURCE_LABELS] ?? r;
    const draft: AlertDraft = {
      triggerType: "sync_failure",
      dedupeKey: `syncfail:${syncIncidentSignature(failures)}:${stampFor(failures)}`,
      occurredAt: nowSec,
      title: failures.length === 1 ? "Data source stopped updating" : `${failures.length} data sources stopped updating`,
      message: `${failures.map(label).join(", ")} ${failures.length === 1 ? "is" : "are"} no longer updating. Check Sync Status.`,
      payload: { resources: failures },
      provenance: { confidence: "exact", sources: ["SyncState"] },
      clickPath: "/sync",
    };
    return { drafts: [draft], nextState, needsLive: false };
  }
  if (recoveries.length === 0) return { drafts: [], nextState, needsLive: false };
  const label = (r: string) => RESOURCE_LABELS[r as keyof typeof RESOURCE_LABELS] ?? r;
  const draft: AlertDraft = {
    triggerType: "sync_recovery",
    dedupeKey: `syncrecover:${syncIncidentSignature(recoveries)}:${stampFor(recoveries)}`,
    occurredAt: nowSec,
    title: "Data source recovered",
    message: `${recoveries.map(label).join(", ")} ${recoveries.length === 1 ? "is" : "are"} updating again.`,
    payload: { resources: recoveries },
    provenance: { confidence: "exact", sources: ["SyncState"] },
    clickPath: "/sync",
  };
  return { drafts: [draft], nextState, needsLive: false };
}

/* -------------------------------------------------------------------------- */
/* 2.10.0 evaluators (worker wiring — pure logic lives in shared/alerts.ts)   */
/* -------------------------------------------------------------------------- */

async function evaluateNetworthDrawdownRule(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  config: { pct?: number },
  nowSec: number
): Promise<RuleEvaluation> {
  if (stored.drawdown === null) {
    const boundarySec = nowSec - NETWORTH_DRAWDOWN_BASELINE_SECONDS;
    const [baselineRow, currentRow] = await Promise.all([
      db.networthSnapshot.findFirst({
        where: { userId, capturedAt: { lte: new Date(boundarySec * 1000) } },
        orderBy: { capturedAt: "desc" },
        select: { id: true, capturedAt: true, total: true },
      }),
      db.networthSnapshot.findFirst({
        where: { userId },
        orderBy: { capturedAt: "desc" },
        select: { id: true, capturedAt: true, total: true },
      }),
    ]);
    const toPoint = (row: { id: string; capturedAt: Date; total: bigint } | null): NetworthPoint | null =>
      row ? { id: row.id, capturedAt: Math.floor(row.capturedAt.getTime() / 1000), total: row.total.toString() } : null;
    const baseline = toPoint(baselineRow);
    const current = toPoint(currentRow);
    stored.drawdown = {
      baseline: baseline !== null && baseline.id === current?.id ? null : baseline,
      current: current !== null && nowSec - current.capturedAt <= NETWORTH_CURRENT_MAX_AGE_SECONDS ? current : null,
    };
  }
  const { baseline, current } = stored.drawdown;
  const openEpisodeKey = previous?.openEpisode?.baselineId ?? null;
  const result = evaluateNetworthDrawdown(baseline, current, config, nowSec, openEpisodeKey);

  if (previous === null) {
    return { drafts: [], nextState: { observedAt: nowSec, openEpisode: null }, needsLive: false };
  }
  if (!result.eligible) {
    if (result.reason === undefined) {
      return { drafts: [], nextState: { observedAt: previous.observedAt, openEpisode: null }, needsLive: false };
    }
    return { drafts: [], nextState: { observedAt: previous.observedAt, openEpisode: previous.openEpisode ?? null }, needsLive: false };
  }
  const episodeKey = networthDrawdownEpisodeKey(baseline!.id);
  const dropPct = Math.round(result.dropPct * 10) / 10;
  const draft: AlertDraft = {
    triggerType: "networth_drawdown",
    dedupeKey: `nwdrawdown:${baseline!.id}:${current!.id}`,
    occurredAt: current!.capturedAt,
    title: "Net worth drawdown vs 7 days ago",
    message: `Net worth fell ${dropPct}% against the snapshot from 7 days ago — ${formatMoney(Number(result.baselineTotal))} → ${formatMoney(Number(result.currentTotal))}.`,
    payload: {
      dropPct,
      pct: typeof config.pct === "number" ? config.pct : 10,
      baselineTotal: result.baselineTotal,
      currentTotal: result.currentTotal,
      baselineAtSec: baseline!.capturedAt,
      currentAtSec: current!.capturedAt,
    },
    provenance: {
      confidence: "exact",
      sources: ["NetworthSnapshot"],
      window: { fromSec: baseline!.capturedAt, toSec: current!.capturedAt },
    },
    clickPath: "/money",
  };
  return { drafts: [draft], nextState: { observedAt: previous.observedAt, openEpisode: { baselineId: episodeKey } }, needsLive: false };
}

function evaluateBankMaturitySoon(
  previous: AlertRuleState | null,
  live: AlertTimerState | null,
  config: Record<string, unknown>,
  nowSec: number
): RuleEvaluation {
  if (live === null) return { drafts: [], nextState: null, needsLive: true };
  const withinHours = typeof config.within_hours === "number" ? config.within_hours : 24;
  const signaled = previous?.signaled?.bank ?? null;
  const result = evaluateImminentTimer(live.bankMaturesAt ?? null, nowSec, withinHours * 3600, signaled);
  const nextState: AlertRuleState = { observedAt: nowSec };
  if (!result.eligible || result.endSec === null) {
    return { drafts: [], nextState, needsLive: true };
  }
  const draft: AlertDraft = {
    triggerType: "bank_maturity_soon",
    dedupeKey: `banksoon:${result.endSec}`,
    occurredAt: result.endSec,
    title: "Bank investment matures soon",
    message: `A city-bank investment matures within ${withinHours}h — plan your next move.`,
    payload: { maturesAtSec: result.endSec, withinHours },
    provenance: { confidence: "exact", sources: ["Torn /user live timers"] },
    clickPath: "/money",
  };
  return {
    drafts: [draft],
    nextState: { ...nextState, signaled: { ...(previous?.signaled ?? {}), bank: result.endSec } },
    needsLive: true,
  };
}

async function evaluateOcAlmostReady(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  config: Record<string, unknown>,
  nowSec: number
): Promise<RuleEvaluation> {
  const withinHours = typeof config.within_hours === "number" ? config.within_hours : 6;
  if (stored.ocsImminent === null) {
    const account = await db.tornAccount.findUnique({ where: { userId }, select: { tornId: true } });
    if (account?.tornId == null) return { drafts: [], nextState: { observedAt: nowSec }, needsLive: false };
    const rows = await db.organizedCrime.findMany({
      where: {
        userId,
        status: "recruiting",
        readyAt: { not: null, gt: new Date(nowSec * 1000), lte: new Date((nowSec + withinHours * 3600) * 1000) },
      },
      select: { ocId: true, name: true, readyAt: true, slots: true },
    });
    const slotsIncludeUser = (slots: unknown): boolean => {
      if (!Array.isArray(slots)) return false;
      return (slots as Array<{ user?: { id?: number } | null }>).some((s) => s.user?.id === account.tornId);
    };
    stored.ocsImminent = rows
      .filter((r) => r.readyAt !== null && slotsIncludeUser(r.slots))
      .map((r) => ({ ocId: r.ocId, name: r.name, readyAtSec: Math.floor(r.readyAt!.getTime() / 1000) }));
  }
  const drafts: AlertDraft[] = [];
  const signaled = { ...(previous?.signaled ?? {}) };
  for (const oc of stored.ocsImminent) {
    const key = `oc:${oc.ocId}`;
    const result = evaluateImminentTimer(oc.readyAtSec, nowSec, withinHours * 3600, signaled[key] ?? null);
    if (!result.eligible) continue;
    signaled[key] = oc.readyAtSec;
    drafts.push({
      triggerType: "oc_almost_ready",
      dedupeKey: `ocsoon:${oc.ocId}:${oc.readyAtSec}`,
      occurredAt: nowSec,
      title: `OC almost ready: ${oc.name}`,
      message: `Your organized crime initiates within ${withinHours}h.`,
      payload: { ocId: oc.ocId, name: oc.name, readyAtSec: oc.readyAtSec, withinHours },
      provenance: { confidence: "exact", sources: ["OrganizedCrime"] },
      clickPath: "/faction",
    });
  }
  return { drafts, nextState: { observedAt: nowSec, signaled }, needsLive: false };
}

type CappedBar = "energy" | "nerve" | "happy";

function barsFromConfig(config: Record<string, unknown>): CappedBar[] {
  const raw = (config as { bars?: unknown }).bars;
  if (!Array.isArray(raw) || raw.length === 0) return ["energy"];
  return raw.filter((b): b is CappedBar => b === "energy" || b === "nerve" || b === "happy");
}

/** UTC calendar day key for the per-day bar_capped dedupe scope. */
function utcDayKey(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

async function evaluateBarCappedRule(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  live: AlertTimerState | null,
  stored: StoredInputs,
  config: Record<string, unknown>,
  nowSec: number
): Promise<RuleEvaluation> {
  if (live === null) return { drafts: [], nextState: null, needsLive: true };
  const bars = barsFromConfig(config);
  const minutes = typeof config.minutes === "number" ? config.minutes : 30;
  if (bars.includes("happy") && stored.latestBars === null) {
    const row = await db.barsSnapshot.findFirst({
      where: { userId },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, happyCurrent: true, happyMaximum: true },
    });
    stored.latestBars = row
      ? { capturedAtSec: Math.floor(row.capturedAt.getTime() / 1000), happyCurrent: row.happyCurrent, happyMaximum: row.happyMaximum }
      : null;
  }
  const drafts: AlertDraft[] = [];
  const cappedSince: Record<string, number | null> = { ...(previous?.cappedSince ?? {}) };
  const firedDay: Record<string, string> = { ...(previous?.cappedFiredDay ?? {}) };

  for (const bar of bars) {
    // Energy/nerve: the live timer reports the exact moment the bar became
    // full (energyFullAt/nerveFullAt in the past). Happy: TornScope stores
    // no happy-full timer, so the capped duration is anchored at the first
    // capped BarsSnapshot observation (state machine below).
    let cappedSinceSec: number | null = null;
    if (bar === "energy") {
      const fullAt = live.energyFullAt ?? null;
      cappedSinceSec = fullAt !== null && fullAt <= nowSec ? fullAt : null;
    } else if (bar === "nerve") {
      const fullAt = live.nerveFullAt ?? null;
      cappedSinceSec = fullAt !== null && fullAt <= nowSec ? fullAt : null;
    } else {
      const snap = stored.latestBars;
      const cappedNow = snap !== null && snap.happyMaximum > 0 && snap.happyCurrent >= snap.happyMaximum;
      const prevSince = previous?.cappedSince?.happy ?? null;
      cappedSinceSec = cappedNow ? (prevSince ?? snap!.capturedAtSec) : null;
    }

    cappedSince[bar] = cappedSinceSec;
    const result = evaluateBarCappedDuration(cappedSinceSec, nowSec, minutes, firedDay[bar] === utcDayKey(nowSec));
    if (!result.eligible) continue;
    firedDay[bar] = utcDayKey(nowSec);
    const label = bar === "energy" ? "Energy" : bar === "nerve" ? "Nerve" : "Happy";
    const source = bar === "happy" ? "BarsSnapshot" : "Torn /user live timers";
    drafts.push({
      triggerType: "bar_capped",
      dedupeKey: `barcapped:${bar}:${utcDayKey(nowSec)}`,
      occurredAt: cappedSinceSec! + minutes * 60,
      title: `${label} capped for ${minutes}m+`,
      message: `${label} has sat at maximum for ${minutes} minutes — the regen above the cap is wasted.`,
      payload: { bar, minutes, cappedSinceSec },
      provenance: { confidence: "exact", sources: [source] },
      clickPath: "/energy",
    });
  }
  return { drafts, nextState: { observedAt: nowSec, cappedSince, cappedFiredDay: firedDay }, needsLive: true };
}

async function evaluateGoalMilestoneRule(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  nowSec: number
): Promise<RuleEvaluation> {
  if (stored.activeGoals === null || stored.goalFacts === null) {
    const goals = await db.goal.findMany({
      where: { userId, status: "active" },
      select: { id: true, metric: true, target: true },
    });
    const metrics = new Set(goals.map((g) => g.metric));
    const facts: GoalFacts = { networthSnapshots: [], battlestatSeries: [], levelSeries: [] };
    if (metrics.has("networth") || metrics.has("liquid_wealth")) {
      const row = await db.networthSnapshot.findFirst({
        where: { userId },
        orderBy: { capturedAt: "desc" },
      });
      if (row) {
        const num = (v: bigint): number => Number(v);
        const snap = {
          ...row,
          total: num(row.total), pending: num(row.pending), wallet: num(row.wallet), vault: num(row.vault),
          bookie: num(row.bookie), cityBank: num(row.cityBank), caymanBank: num(row.caymanBank),
          piggyBank: num(row.piggyBank), loans: num(row.loans), unpaidFees: num(row.unpaidFees),
          inventory: num(row.inventory), displayCase: num(row.displayCase), bazaar: num(row.bazaar),
          trades: num(row.trades), itemMarket: num(row.itemMarket), auctionHouse: num(row.auctionHouse),
          enlistedCars: num(row.enlistedCars), property: num(row.property), stockMarket: num(row.stockMarket),
          company: num(row.company), points: num(row.points),
        };
        facts.networthSnapshots = [snap as never];
      }
    }
    if ([...metrics].some((m) => m === "battlestats_total" || m === "strength" || m === "defense" || m === "speed" || m === "dexterity")) {
      const row = await db.personalStatSnapshot.findFirst({
        where: { userId },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true, stats: true },
      });
      if (row) {
        facts.battlestatSeries = [{ t: Math.floor(row.capturedAt.getTime() / 1000), ...extractBattlestats(row.stats) }];
      }
    }
    if (metrics.has("level")) {
      const row = await db.userSnapshot.findFirst({
        where: { userId },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true, level: true },
      });
      if (row) facts.levelSeries = [{ t: Math.floor(row.capturedAt.getTime() / 1000), level: row.level }];
    }
    stored.activeGoals = goals.map((g) => ({
      id: g.id,
      metric: g.metric as GoalMetricId,
      target: Number(g.target),
    }));
    stored.goalFacts = facts;
  }

  const goalFractions: Record<string, number> = { ...(previous?.goalFractions ?? {}) };
  const drafts: AlertDraft[] = [];
  for (const goal of stored.activeGoals) {
    const current = goalCurrentValue(goal.metric, stored.goalFacts);
    const progress = current !== null && goal.target > 0 ? current.value / goal.target : null;
    const result = evaluateGoalMilestone(progress, goalFractions[goal.id] ?? null, GOAL_MILESTONE_FRACTIONS);
    goalFractions[goal.id] = result.highestReached ?? goalFractions[goal.id] ?? 0;
    if (result.newlyReached === null) continue;
    const pct = Math.round(result.newlyReached * 100);
    drafts.push({
      triggerType: "goal_milestone",
      dedupeKey: `goal:${goal.id}:m:${result.newlyReached}`,
      occurredAt: current?.at ?? nowSec,
      title: `Goal ${pct}% reached`,
      message: `Your ${goal.metric} goal is ${pct}% complete.`,
      payload: { goalId: goal.id, metric: goal.metric, target: goal.target, fraction: result.newlyReached, progress },
      provenance: {
        confidence: "derived",
        sources: ["Goal", "NetworthSnapshot", "PersonalStatSnapshot"],
        window: current ? { fromSec: current.at, toSec: current.at } : undefined,
      },
      clickPath: "/goals",
    });
  }
  return { drafts, nextState: { observedAt: nowSec, goalFractions }, needsLive: false };
}

async function evaluateRehabAdviceRule(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  config: Record<string, unknown>,
  nowSec: number
): Promise<RuleEvaluation> {
  const count = typeof config.count === "number" ? config.count : 3;
  const windowHours = typeof config.window_hours === "number" ? config.window_hours : 24;
  const cleanHours = typeof config.clean_hours === "number" ? config.clean_hours : 24;
  if (stored.drugEventTimes === null) {
    const since = new Date((nowSec - (windowHours + cleanHours + 1) * 3600) * 1000);
    const rows = await db.drugEvent.findMany({
      where: { userId, outcome: "success", occurredAt: { gte: since } },
      select: { occurredAt: true },
    });
    stored.drugEventTimes = rows.map((r) => Math.floor(r.occurredAt.getTime() / 1000));
  }
  const result = evaluateDrugWindow(stored.drugEventTimes, nowSec, { count, windowHours, cleanHours }, previous?.conditionEpisode?.sinceSec ?? null);
  const nextState: AlertRuleState = { observedAt: nowSec, conditionEpisode: result.episodeOpen ? { sinceSec: result.episodeSinceSec! } : null };
  if (!result.eligible) return { drafts: [], nextState, needsLive: false };
  const draft: AlertDraft = {
    triggerType: "rehab_advice",
    dedupeKey: `rehab:${result.episodeSinceSec}`,
    occurredAt: result.windowEarliestAtSec ?? nowSec,
    title: "Rehab may be worth considering",
    message: `${result.windowCount} drug uses inside ${windowHours}h. Torn publishes no addiction meter — this alert uses your recent drug volume as a proxy, not a medical reading.`,
    payload: { count: result.windowCount, windowHours, episodeSinceSec: result.episodeSinceSec },
    provenance: {
      confidence: "inferred",
      sources: ["DrugEvent"],
      window: { fromSec: result.windowEarliestAtSec ?? nowSec, toSec: nowSec },
      note: "Proxy: Torn publishes no addiction points; the trigger counts stored drug events only.",
    },
    clickPath: "/drugs",
  };
  return { drafts: [draft], nextState, needsLive: false };
}

async function evaluateOverdoseSpikeRule(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  config: Record<string, unknown>,
  nowSec: number
): Promise<RuleEvaluation> {
  const count = typeof config.count === "number" ? config.count : 2;
  const windowHours = typeof config.window_hours === "number" ? config.window_hours : 24;
  const baselineDays = typeof config.baseline_days === "number" ? config.baseline_days : 90;
  if (stored.overdoseTimes === null) {
    const since = new Date((nowSec - baselineDays * 86_400) * 1000);
    const rows = await db.drugEvent.findMany({
      where: { userId, outcome: "overdose", occurredAt: { gte: since } },
      select: { occurredAt: true },
    });
    stored.overdoseTimes = rows.map((r) => Math.floor(r.occurredAt.getTime() / 1000));
  }
  const result = evaluateOverdoseSpike(stored.overdoseTimes, nowSec, { count, windowHours, baselineDays });
  if (!result.eligible) return { drafts: [], nextState: { observedAt: nowSec }, needsLive: false };
  // Per-incident identity: the latest overdose inside the window — each new
  // overdose is a new incident member and alerts once (idempotent replays
  // through the (userId, dedupeKey) constraint).
  const windowStart = nowSec - windowHours * 3600;
  const latest = Math.max(...stored.overdoseTimes.filter((t) => t >= windowStart && t <= nowSec));
  const rate = result.baselineRatePerDay !== null ? Math.round(result.baselineRatePerDay * 1000) / 1000 : null;
  const draft: AlertDraft = {
    triggerType: "drug_overdose_spike",
    dedupeKey: `odspike:${latest}`,
    occurredAt: latest,
    title: "Overdose spike",
    message: `${result.windowCount} overdoses inside ${windowHours}h — your stored baseline is ${rate ?? "—"} per day. Consider spacing uses out.`,
    payload: { windowCount: result.windowCount, windowHours, baselineRatePerDay: rate },
    provenance: {
      confidence: "exact",
      sources: ["DrugEvent"],
      window: { fromSec: windowStart, toSec: nowSec },
      note: rate === null ? undefined : `Baseline: overdoses/day over the preceding ${baselineDays} days.`,
    },
    clickPath: "/drugs",
  };
  return { drafts: [draft], nextState: { observedAt: nowSec }, needsLive: false };
}

async function evaluateTrainingStagnationRule(
  db: ReturnType<typeof getPrismaClient>,
  userId: string,
  previous: AlertRuleState | null,
  stored: StoredInputs,
  config: Record<string, unknown>,
  nowSec: number
): Promise<RuleEvaluation> {
  const windowDays = typeof config.window_days === "number" ? config.window_days : 7;
  if (stored.latestStats === null || stored.comparisonStats === null) {
    const latestRow = await db.personalStatSnapshot.findFirst({
      where: { userId },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, stats: true },
    });
    const comparisonRow = await db.personalStatSnapshot.findFirst({
      where: { userId, capturedAt: { lte: new Date((nowSec - windowDays * 86_400) * 1000) } },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, stats: true },
    });
    const toTotal = (row: { capturedAt: Date; stats: unknown } | null): { total: number; atSec: number } | null => {
      if (row === null) return null;
      const extracted = extractBattlestats(row.stats);
      const total = extracted.total ?? [...[extracted.strength, extracted.defense, extracted.speed, extracted.dexterity]].reduce<number | null>((acc, v) => (acc === null || v === null ? acc : acc + v), 0);
      if (total === null) return null;
      return { total, atSec: Math.floor(row.capturedAt.getTime() / 1000) };
    };
    stored.latestStats = toTotal(latestRow);
    stored.comparisonStats = toTotal(comparisonRow);
  }
  const result = evaluateTrainingStagnation(stored.latestStats, stored.comparisonStats, nowSec, { windowDays });
  const wasOpen = previous?.conditionEpisode !== null && previous?.conditionEpisode !== undefined;

  if (!result.stagnant) {
    // Genuine reset (observed gain) closes the episode; data-quality reasons
    // (missing/stale comparison) leave it untouched — a sync outage must not
    // re-alert the same stagnation when fresh data returns.
    const closesEpisode = result.reason === "gained";
    return {
      drafts: [],
      nextState: { observedAt: nowSec, conditionEpisode: closesEpisode ? null : previous?.conditionEpisode ?? null },
      needsLive: false,
    };
  }
  if (wasOpen) {
    return { drafts: [], nextState: { observedAt: nowSec, conditionEpisode: previous!.conditionEpisode! }, needsLive: false };
  }
  const episodeSince = stored.comparisonStats!.atSec;
  const draft: AlertDraft = {
    triggerType: "training_stagnation",
    dedupeKey: `trainstag:${episodeSince}`,
    occurredAt: stored.latestStats!.atSec,
    title: "Training stagnation",
    message: `No battle-stat gain in ${windowDays} days (${stored.latestStats!.total} → ${stored.comparisonStats!.total}). Stored snapshots only — job/company stat points are not separable here.`,
    payload: {
      windowDays,
      latestTotal: stored.latestStats!.total,
      comparisonTotal: stored.comparisonStats!.total,
      comparisonAtSec: stored.comparisonStats!.atSec,
    },
    provenance: {
      confidence: "derived",
      sources: ["PersonalStatSnapshot"],
      window: { fromSec: stored.comparisonStats!.atSec, toSec: stored.latestStats!.atSec },
      note: "Hourly snapshot deltas; non-gym stat gains are not separable at this cadence.",
    },
    clickPath: "/progression",
  };
  return { drafts: [draft], nextState: { observedAt: nowSec, conditionEpisode: { sinceSec: episodeSince } }, needsLive: false };
}

/* -------------------------------------------------------------------------- */
/* Rule dispatch + commit                                                     */
/* -------------------------------------------------------------------------- */

type PrismaDb = ReturnType<typeof getPrismaClient>;

interface RuleLike {
  id: string;
  userId: string;
  triggerType: string;
  config: unknown;
  quietHours: unknown;
  cooldownMinutes: number;
  lastFiredAt: Date | null;
  lastState: unknown;
  /** User snooze (2.10.0): while in the future the rule is skipped without
   *  touching lastState — snoozing must not reset transition/episode memory. */
  snoozedUntil: Date | null;
}

async function evaluateRule(
  db: PrismaDb,
  userId: string,
  rule: RuleLike,
  ctx: { nowSec: number; live: AlertTimerState | null; stored: StoredInputs; channelIds: string[] }
): Promise<void> {
  const meta = alertTrigger(rule.triggerType);
  if (!meta) return; // unknown type persisted by an older build — ignore
  if (rule.snoozedUntil !== null && rule.snoozedUntil.getTime() > Date.now()) return; // snoozed
  const previous = parseAlertRuleState(rule.lastState);

  let result: RuleEvaluation = { drafts: [], nextState: null, needsLive: meta.needsLiveFetch };
  switch (rule.triggerType) {
    case "cooldown_ready":
      result = evaluateCooldownReady(previous, ctx.live, (rule.config ?? {}) as Record<string, unknown>, ctx.nowSec, meta.maxObservationGapSeconds);
      break;
    case "travel_landed":
      result = evaluateTravelLanded(previous, ctx.live, {}, ctx.nowSec, meta.maxObservationGapSeconds);
      break;
    case "education_done":
      result = evaluateEducationDone(previous, ctx.live, {}, ctx.nowSec, meta.maxObservationGapSeconds);
      break;
    case "bank_matured":
      result = evaluateBankMatured(previous, ctx.live, {}, ctx.nowSec, meta.maxObservationGapSeconds);
      break;
    case "oc_ready":
      result = await evaluateOcReady(db, userId, previous, ctx.stored, ctx.nowSec, OC_MAX_OBSERVATION_GAP_SECONDS);
      break;
    case "net_worth_drop":
      result = await evaluateNetWorthDrop(
        db,
        userId,
        rule.id,
        previous,
        ctx.stored,
        (rule.config ?? {}),
        ctx.nowSec
      );
      break;
    case "sync_failure":
      result = await evaluateSyncHealth(userId, previous, ctx.stored, "sync_failure", ctx.nowSec);
      break;
    case "sync_recovery":
      result = await evaluateSyncHealth(userId, previous, ctx.stored, "sync_recovery", ctx.nowSec);
      break;
    case "networth_drawdown":
      result = await evaluateNetworthDrawdownRule(db, userId, previous, ctx.stored, (rule.config ?? {}) as { pct?: number }, ctx.nowSec);
      break;
    case "bar_capped":
      result = await evaluateBarCappedRule(db, userId, previous, ctx.live, ctx.stored, (rule.config ?? {}) as Record<string, unknown>, ctx.nowSec);
      break;
    case "bank_maturity_soon":
      result = evaluateBankMaturitySoon(previous, ctx.live, (rule.config ?? {}) as Record<string, unknown>, ctx.nowSec);
      break;
    case "oc_almost_ready":
      result = await evaluateOcAlmostReady(db, userId, previous, ctx.stored, (rule.config ?? {}) as Record<string, unknown>, ctx.nowSec);
      break;
    case "goal_milestone":
      result = await evaluateGoalMilestoneRule(db, userId, previous, ctx.stored, ctx.nowSec);
      break;
    case "rehab_advice":
      result = await evaluateRehabAdviceRule(db, userId, previous, ctx.stored, (rule.config ?? {}) as Record<string, unknown>, ctx.nowSec);
      break;
    case "drug_overdose_spike":
      result = await evaluateOverdoseSpikeRule(db, userId, previous, ctx.stored, (rule.config ?? {}) as Record<string, unknown>, ctx.nowSec);
      break;
    case "training_stagnation":
      result = await evaluateTrainingStagnationRule(db, userId, previous, ctx.stored, (rule.config ?? {}) as Record<string, unknown>, ctx.nowSec);
      break;
  }

  // State-transition triggers evaluated without their required observation
  // (live fetch failed/skipped): keep the previous baseline untouched.
  if (result.nextState === null && result.needsLive) return;

  const qh = parseAlertQuietHours(rule.quietHours);
  const quietNow = qh !== null && isAlertQuietNow(qh, ctx.nowSec);

  for (const draft of result.drafts) {
    await commitAlert(db, rule, draft, { quietNow, qh, channelIds: ctx.channelIds, nowSec: ctx.nowSec });
  }

  if (result.nextState !== null) {
    // lastFiredAt is NOT touched here — only commitAlert (a real committed
    // delivery) updates it. State advances so consumed transitions are not
    // re-notified; the merge preserves foreign slices.
    const merged = { ...(previous ?? {}), ...result.nextState } as AlertRuleState;
    await db.alertRule.update({ where: { id: rule.id }, data: { lastState: merged as never } }).catch(() => undefined);
  }
}

/**
 * Commit one logical alert: rule cooldown gate, quiet-hours policy, then ONE
 * transaction creating the in-app delivery (the logical alert; the unique
 * (userId, dedupeKey) constraint absorbs concurrent ticks and worker
 * restarts) plus one pending external row per enabled channel.
 *
 * QUIET HOURS (2.10.0): the alert is DEFERRED, never dropped — the delivery
 * is stamped "deferred" with `deferredUntil` = the rule's quiet-window end,
 * and the channel rows stay "pending" with nextAttemptAt at that same
 * instant, so dispatch.ts delivers them when quiet hours end. The inbox
 * explains the state instead of silently losing the alert.
 */
async function commitAlert(
  db: PrismaDb,
  rule: RuleLike,
  draft: AlertDraft,
  opts: { quietNow: boolean; qh: AlertQuietHours | null; channelIds: string[]; nowSec: number }
): Promise<void> {
  // Per-rule cooldown: blocks repeated notifications while still allowing a
  // NEW episode after expiry. Blocked attempts leave no trace (they are
  // repeats, not events) and never update lastFiredAt.
  if (rule.cooldownMinutes > 0 && rule.lastFiredAt !== null) {
    const elapsedMs = Date.now() - rule.lastFiredAt.getTime();
    if (elapsedMs < rule.cooldownMinutes * 60_000) return;
  }

  let status: "sent" | "deferred" = "sent";
  let deferredUntil: Date | null = null;
  let firstAttemptAt: Date | null = null;
  if (opts.quietNow && opts.qh !== null) {
    deferredUntil = new Date(alertQuietEndSec(opts.qh, opts.nowSec) * 1000);
    firstAttemptAt = deferredUntil;
    status = "deferred";
  }
  try {
    await db.$transaction(async (tx) => {
      const delivery = await tx.alertDelivery.create({
        data: {
          userId: rule.userId,
          ruleId: rule.id,
          triggerType: draft.triggerType,
          dedupeKey: draft.dedupeKey,
          occurredAt: new Date(draft.occurredAt * 1000),
          title: draft.title,
          message: draft.message,
          payload: (draft.payload ?? undefined) as never,
          provenance: draft.provenance as never,
          status,
          deferredUntil,
        },
        select: { id: true },
      });
      // External fan-out rows: "pending" with nextAttemptAt set (= deferredUntil
      // during quiet hours, NULL = due immediately otherwise). Dispatch picks
      // them up when due — a deferred alert goes OUT at quiet end, never lost.
      for (const channelId of opts.channelIds) {
        await tx.alertChannelDelivery
          .create({
            data: {
              userId: rule.userId,
              deliveryId: delivery.id,
              channelId,
              status: "pending",
              nextAttemptAt: firstAttemptAt,
            },
            select: { id: true },
          })
          .catch(() => undefined); // (channelId, deliveryId) unique → idempotent
      }
      if (!opts.quietNow) {
        await tx.alertRule.update({
          where: { id: rule.id },
          data: { lastFiredAt: new Date() },
        });
      }
    });
    logger.info(
      { userId: rule.userId, triggerType: draft.triggerType, dedupeKey: draft.dedupeKey, status, deferredUntil, channels: opts.channelIds.length },
      "alert committed"
    );
  } catch {
    // Unique violation on (userId, dedupeKey): the same logical alert was
    // already committed by a concurrent tick — nothing to do.
  }
}
