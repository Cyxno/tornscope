import {
  alertTrigger,
  cooldownKindsFromConfig,
  diffAlertTimers,
  diffSyncHealth,
  evaluateNetworthDrop,
  formatMoney,
  isAlertQuietNow,
  NETWORTH_CURRENT_MAX_AGE_SECONDS,
  networthEpisodeKey,
  parseAlertQuietHours,
  parseAlertRuleState,
  sendDiscordWebhook,
  syncIncidentSignature,
  type AlertDraft,
  type AlertRuleState,
  type AlertTimerState,
  type NetworthPoint,
} from "@tornscope/shared";
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
  networth: { baseline: NetworthPoint | null; current: NetworthPoint | null } | null;
  syncFailing: string[] | null;
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

  const stored: StoredInputs = { ocsReady: null, networth: null, syncFailing: null };
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
  copy: (event: { kind: TimerKind; endSec: number; label: string }) => { title: string; message: string }
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
      clickPath: alertTrigger(triggerType)?.clickPath ?? "/today",
    };
  });
  return { drafts, nextState: { observedAt: nowSec, timers: live }, needsLive: true };
}

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
  }));
}

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
  }));
}

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
  }));
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
  }));
}

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
    // Re-arm when the condition genuinely reset (recovered above threshold
    // or the window moved to a new baseline) — the evaluator signals this by
    // a crossed=false result with no open-episode lock on THIS baseline.
    const episodeKey = baseline ? networthEpisodeKey(baseline.id) : null;
    const stillLocked = result.reason === "still_open_episode";
    const openEpisode = stillLocked && episodeKey ? { baselineId: episodeKey } : null;
    return {
      drafts: [],
      nextState: { observedAt: previous.observedAt, openEpisode },
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
      select: { resource: true, status: true, errorCount: true, lastErrorKind: true },
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
  }
  const prevFailing = previous?.failing ?? null;
  const { failures, recoveries } = diffSyncHealth(prevFailing, stored.syncFailing);
  const nextState: AlertRuleState = { observedAt: nowSec, failing: stored.syncFailing };
  if (prevFailing === null) return { drafts: [], nextState, needsLive: false }; // baseline

  if (direction === "sync_failure") {
    if (failures.length === 0) return { drafts: [], nextState, needsLive: false };
    const label = (r: string) => RESOURCE_LABELS[r as keyof typeof RESOURCE_LABELS] ?? r;
    const draft: AlertDraft = {
      triggerType: "sync_failure",
      dedupeKey: `syncfail:${syncIncidentSignature(failures)}`,
      occurredAt: nowSec,
      title: failures.length === 1 ? "Data source stopped updating" : `${failures.length} data sources stopped updating`,
      message: `${failures.map(label).join(", ")} ${failures.length === 1 ? "is" : "are"} no longer updating. Check Sync Status.`,
      payload: { resources: failures },
      clickPath: "/sync",
    };
    return { drafts: [draft], nextState, needsLive: false };
  }
  if (recoveries.length === 0) return { drafts: [], nextState, needsLive: false };
  const label = (r: string) => RESOURCE_LABELS[r as keyof typeof RESOURCE_LABELS] ?? r;
  const draft: AlertDraft = {
    triggerType: "sync_recovery",
    dedupeKey: `syncrecover:${syncIncidentSignature(recoveries)}`,
    occurredAt: nowSec,
    title: "Data source recovered",
    message: `${recoveries.map(label).join(", ")} ${recoveries.length === 1 ? "is" : "are"} updating again.`,
    payload: { resources: recoveries },
    clickPath: "/sync",
  };
  return { drafts: [draft], nextState, needsLive: false };
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
}

async function evaluateRule(
  db: PrismaDb,
  userId: string,
  rule: RuleLike,
  ctx: { nowSec: number; live: AlertTimerState | null; stored: StoredInputs; channelIds: string[] }
): Promise<void> {
  const meta = alertTrigger(rule.triggerType);
  if (!meta) return; // unknown type persisted by an older build — ignore
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
  }

  // State-transition triggers evaluated without their required observation
  // (live fetch failed/skipped): keep the previous baseline untouched.
  if (result.nextState === null && result.needsLive) return;

  const qh = parseAlertQuietHours(rule.quietHours);
  const quietNow = qh !== null && isAlertQuietNow(qh, ctx.nowSec);

  for (const draft of result.drafts) {
    await commitAlert(db, rule, draft, { quietNow, channelIds: ctx.channelIds, nowSec: ctx.nowSec });
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
 */
async function commitAlert(
  db: PrismaDb,
  rule: RuleLike,
  draft: AlertDraft,
  opts: { quietNow: boolean; channelIds: string[]; nowSec: number }
): Promise<void> {
  // Per-rule cooldown: blocks repeated notifications while still allowing a
  // NEW episode after expiry. Blocked attempts leave no trace (they are
  // repeats, not events) and never update lastFiredAt.
  if (rule.cooldownMinutes > 0 && rule.lastFiredAt !== null) {
    const elapsedMs = Date.now() - rule.lastFiredAt.getTime();
    if (elapsedMs < rule.cooldownMinutes * 60_000) return;
  }

  const status = opts.quietNow ? "suppressed" : "sent";
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
          status,
        },
        select: { id: true },
      });
      // External fan-out only when the alert was actually delivered in-app;
      // suppressed rows keep their own suppressed channel rows so the UI can
      // explain what happened (spec 6: never silently discarded).
      for (const channelId of opts.channelIds) {
        await tx.alertChannelDelivery
          .create({
            data: {
              userId: rule.userId,
              deliveryId: delivery.id,
              channelId,
              status: opts.quietNow ? "suppressed" : "pending",
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
      { userId: rule.userId, triggerType: draft.triggerType, dedupeKey: draft.dedupeKey, status, channels: opts.channelIds.length },
      "alert committed"
    );
  } catch {
    // Unique violation on (userId, dedupeKey): the same logical alert was
    // already committed by a concurrent tick — nothing to do.
  }
}
