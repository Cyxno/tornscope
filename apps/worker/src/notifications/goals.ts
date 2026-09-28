import { getGoalFacts, getPrismaClient } from "@tornscope/database";
import { buildGoalView, deriveInsights, GOAL_MILESTONE_FRACTIONS, goalMetricRegistry, reachedMilestone, type GoalLike } from "@tornscope/analytics";
import { notificationType } from "@tornscope/shared";
import { ingest, type IngestContext } from "./engine.js";
import type { SystemStatePatch } from "./producers.js";

/**
 * Intelligence notification producers (2.0): goals, OC readiness and daily
 * significant insight. They follow the SAME producer contract as every other
 * stored-data producer (see producers.ts): state transitions only, silent
 * first-observation arming, age guards, thin bodies — all delivery policy
 * (toggles, dedupe, quiet hours, ledger) lives in ingest.
 *
 * Cost discipline: goals/OC read a handful of indexed rows; the insight
 * producer runs the full derivation AT MOST ONCE PER DAY per profile (its
 * own systemState slice throttles it) and only for the profile that opted in.
 */

function slice(state: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const raw = state?.[key];
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/* -------------------------------------------------------------------------- */
/* Goals: achievement + milestone crossings                                    */
/* -------------------------------------------------------------------------- */

export async function evaluateGoalsProducer(ctx: IngestContext, systemState: Record<string, unknown> | null, updateSystemState: SystemStatePatch): Promise<void> {
  const wantsAchieved = ctx.toggles["goal_achieved"] === true;
  const wantsMilestones = ctx.toggles["goal_milestone"] === true;
  if (!wantsAchieved && !wantsMilestones) return;

  const db = getPrismaClient();
  const nowSec = Math.floor(Date.now() / 1000);
  const [rows, facts] = await Promise.all([
    db.goal.findMany({ where: { userId: ctx.userId, status: "active" } }),
    getGoalFacts(db, ctx.userId, nowSec),
  ]);
  if (rows.length === 0) return;

  const state = slice(systemState, "goals") ?? {};
  let dirty = false;

  for (const row of rows) {
    const goal: GoalLike = {
      id: row.id,
      metric: row.metric as GoalLike["metric"],
      target: Number(row.target),
      note: row.note,
      createdAt: Math.floor(row.createdAt.getTime() / 1000),
      targetDate: row.targetDate ? Math.floor(row.targetDate.getTime() / 1000) : null,
      status: "active",
      achievedAt: null,
    };
    const view = buildGoalView(goal, facts, nowSec);
    const label = goalMetricRegistry[goal.metric]?.label ?? goal.metric;
    if (view.currentValue === null) continue;

    // ---- Achievement (once per goal, ever — dedupeKey is permanent) -------
    if (view.currentValue >= goal.target) {
      if (wantsAchieved) {
        await ingest(ctx.userId, {
          type: "goal_achieved",
          dedupeKey: `goal:achieved:${goal.id}`,
          occurredAt: nowSec,
          title: `Goal reached: ${label}`,
          body: `Your ${label} goal has been reached. Mark it done or raise the bar.`,
          clickPath: "/goals",
          provenance: "derived",
        }, ctx);
      }
      // Persist the achievement so the UI/producer agree without a page load.
      await db.goal.updateMany({ where: { id: goal.id, userId: ctx.userId, status: "active" }, data: { status: "achieved", achievedAt: new Date(nowSec * 1000) } });
      continue;
    }

    // ---- Milestones (once per fraction, ever; highest crossing wins) ------
    if (wantsMilestones && view.progress !== null) {
      const reached = reachedMilestone(view.progress);
      const key = `${goal.id}`;
      const announced = typeof state[key] === "number" ? (state[key] as number) : 0;
      if (reached !== null && reached > announced) {
        const pct = Math.round(reached * 100);
        const outcome = await ingest(ctx.userId, {
          type: "goal_milestone",
          dedupeKey: `goal:milestone:${goal.id}:${pct}`,
          occurredAt: nowSec,
          title: `Goal ${pct}%: ${label}`,
          body: `You are ${pct}% of the way to your ${label} goal.`,
          clickPath: "/goals",
          provenance: "derived",
        }, ctx);
        // Record the milestone even when suppressed (dedupe) — "once, ever".
        if (outcome === "created" || outcome === "duplicate") {
          state[key] = reached;
          dirty = true;
        }
      }
    }
  }

  if (dirty) await updateSystemState({ goals: state });
}

/* -------------------------------------------------------------------------- */
/* OC almost ready (stored OC state; threshold window, once per OC)            */
/* -------------------------------------------------------------------------- */

export async function evaluateOcProducer(ctx: IngestContext, systemState: Record<string, unknown> | null, updateSystemState: SystemStatePatch): Promise<void> {
  const meta = notificationType("oc_ready_soon");
  if (meta === undefined || ctx.toggles["oc_ready_soon"] !== true) return;

  const db = getPrismaClient();
  const account = await db.tornAccount.findUnique({ where: { userId: ctx.userId }, select: { tornId: true } });
  if (account?.tornId == null) return;

  const windowSeconds = ctx.config.ocSoonMinutes * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const ocs = await db.organizedCrime.findMany({
    where: { userId: ctx.userId, status: "recruiting", readyAt: { gte: new Date(nowSec * 1000), lte: new Date((nowSec + windowSeconds) * 1000) } },
    select: { ocId: true, name: true, readyAt: true, slots: true },
  });
  if (ocs.length === 0) return;

  const state = slice(systemState, "oc") ?? {};
  const announced = Array.isArray(state.soonAnnounced) ? (state.soonAnnounced as string[]) : [];
  let dirty = false;

  for (const oc of ocs) {
    const slots = (oc.slots ?? []) as Array<{ user?: { id?: number } | null }>;
    if (!slots.some((s) => s.user?.id === account.tornId)) continue;
    const id = String(oc.ocId);
    if (announced.includes(id)) continue; // once per OC per readiness window
    const readyAt = Math.floor(oc.readyAt!.getTime() / 1000);
    const hours = Math.max(1, Math.round((readyAt - nowSec) / 3600));
    await ingest(ctx.userId, {
      type: "oc_ready_soon",
      dedupeKey: `oc:soon:${id}:${readyAt}`,
      occurredAt: nowSec,
      title: `OC almost ready: ${oc.name}`,
      body: `Your organized crime becomes ready in about ${hours}h.`,
      clickPath: "/faction",
      provenance: "derived",
    }, ctx);
    announced.push(id);
    dirty = true;
  }
  // Retire stale announcements (window passed or OC changed state).
  const activeIds = new Set(ocs.map((o) => String(o.ocId)));
  const cleaned = announced.filter((id) => activeIds.has(id));
  if (dirty || cleaned.length !== announced.length) {
    await updateSystemState({ oc: { soonAnnounced: cleaned } });
  }
}

/* -------------------------------------------------------------------------- */
/* Significant insight (at most ONE per day, highest-priority high-confidence) */
/* -------------------------------------------------------------------------- */

export async function evaluateInsightProducer(ctx: IngestContext, updateSystemState: SystemStatePatch): Promise<void> {
  if (ctx.toggles["significant_insight"] !== true) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const dayKey = new Date(nowSec * 1000).toISOString().slice(0, 10);

  const db = getPrismaClient();
  const rawState = (await db.notificationState.findUnique({ where: { userId: ctx.userId }, select: { systemState: true } }))?.systemState ?? null;
  const state = slice(rawState as Record<string, unknown> | null, "insights") ?? {};
  if (state.lastDay === dayKey) return; // daily throttle — nothing re-runs

  const facts = await gatherForInsights(ctx.userId, nowSec);
  const { insights } = deriveInsights(facts);
  const candidate = insights.find((i) => i.confidence !== "low" && i.priority !== "low") ?? insights.find((i) => i.confidence === "high") ?? null;
  // Mark the day as consumed regardless — one attempt per day keeps the
  // worker cost bounded even when today's data is quiet.
  await updateSystemState({ insights: { lastDay: dayKey } });
  if (candidate === null) return;

  await ingest(ctx.userId, {
    type: "significant_insight",
    dedupeKey: `insight:${candidate.dedupeKey}`,
    occurredAt: nowSec,
    title: candidate.title,
    body: candidate.detail,
    sensitiveBody: ctx.sensitiveDetails ? candidate.sensitiveDetail : null,
    clickPath: candidate.clickPath,
    provenance: candidate.provenance === "inferred" ? "derived" : candidate.provenance,
  }, ctx);
}

/** Lazy import split so the heavy gather is only paid by opted-in profiles. */
let gatherer: typeof import("@tornscope/database") | null = null;
async function gatherForInsights(userId: string, nowSec: number): Promise<Parameters<typeof deriveInsights>[0]> {
  gatherer ??= await import("@tornscope/database");
  const db = gatherer.getPrismaClient();
  return gatherer.gatherInsightFacts(db, userId, nowSec);
}

/** Registry audit: the milestone fractions this producer announces. */
export const GOALS_PRODUCER_MILESTONES = GOAL_MILESTONE_FRACTIONS;
