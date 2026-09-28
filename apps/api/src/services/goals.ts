import {
  DEFAULT_PROJECTION_LOOKBACK,
  GOAL_METRICS,
  GOAL_METRIC_IDS,
  type GoalInput,
  type GoalMetricId,
  type GoalView,
  type GoalsResponse,
  type ProjectionLookbackDays,
} from "@tornscope/shared";
import { getPrismaClient, getGoalFacts } from "@tornscope/database";
import { buildGoalView, type GoalLike } from "@tornscope/analytics";
import { AppError } from "../errors.js";

/**
 * Personal goals (2.0). Goal facts come from the SHARED fact-gatherer in
 * @tornscope/database (the worker's notification producer uses the same
 * one) — a goal read costs a handful of indexed queries and never a Torn
 * API call.
 *
 * Achievement is evaluated LAZILY on every list: when the latest stored
 * value meets the target, the goal is marked achieved (idempotent write).
 * The worker's notification producer runs the same comparison so
 * achievement notifications do not depend on the user opening the page.
 */

function sec(d: Date | null): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null;
}

/** Minimal stored goal row shape (Prisma model fields). */
interface GoalRow {
  id: string;
  metric: string;
  target: bigint;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  targetDate: Date | null;
  status: string;
  achievedAt: Date | null;
}

/** Convert a stored goal row to the API shape (BigInt target → Number). */
export function goalRowToDto(row: GoalRow): GoalLike {
  return {
    id: row.id,
    metric: row.metric as GoalMetricId,
    target: Number(row.target),
    note: row.note,
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
    targetDate: sec(row.targetDate),
    status: row.status as GoalLike["status"],
    achievedAt: sec(row.achievedAt),
  };
}

/** Persist achievement for goals whose latest value meets the target. Idempotent. */
async function markAchieved(db: ReturnType<typeof getPrismaClient>, userId: string, achievedIds: string[], now: number): Promise<void> {
  if (achievedIds.length === 0) return;
  await db.goal.updateMany({
    where: { id: { in: achievedIds }, userId, status: "active" },
    data: { status: "achieved", achievedAt: new Date(now * 1000) },
  });
}

/** List goals with current values and projections. */
export async function listGoals(userId: string, opts: { lookbackDays?: number; demo?: boolean } = {}): Promise<GoalsResponse> {
  const db = getPrismaClient();
  const now = Math.floor(Date.now() / 1000);
  const lookbackDays = (opts.lookbackDays ?? DEFAULT_PROJECTION_LOOKBACK) as ProjectionLookbackDays;
  const [rows, facts] = await Promise.all([db.goal.findMany({ where: { userId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] }), getGoalFacts(db, userId, now)]);

  const views: GoalView[] = [];
  const achievedIds: string[] = [];
  for (const row of rows) {
    const dto = goalRowToDto(row);
    const view = buildGoalView(dto, facts, now, lookbackDays);
    if (row.status === "active" && view.currentValue !== null && view.currentValue >= dto.target) {
      achievedIds.push(row.id);
      view.goal.status = "achieved";
      view.goal.achievedAt = now;
    }
    views.push(view);
  }
  await markAchieved(db, userId, achievedIds, now);

  return { goals: views, metrics: GOAL_METRIC_IDS.map((id) => GOAL_METRICS[id]), defaultLookbackDays: DEFAULT_PROJECTION_LOOKBACK };
}

/** Create a goal. */
export async function createGoal(userId: string, input: GoalInput): Promise<GoalLike> {
  const db = getPrismaClient();
  const row = await db.goal.create({
    data: {
      userId,
      metric: input.metric,
      target: BigInt(Math.round(input.target)),
      note: input.note ?? null,
      targetDate: input.targetDate != null ? new Date(input.targetDate * 1000) : null,
      status: "active",
    },
  });
  return goalRowToDto(row);
}

/** Update target/note/date/status of an own goal. */
export async function updateGoal(userId: string, goalId: string, patch: Partial<Pick<GoalInput, "target" | "note" | "targetDate">> & { status?: "active" | "archived" }): Promise<GoalLike> {
  const db = getPrismaClient();
  const existing = await db.goal.findFirst({ where: { id: goalId, userId } });
  if (!existing) throw new AppError("not_found", "Goal not found.", 404);
  const data: Record<string, unknown> = {};
  if (patch.target !== undefined) data.target = BigInt(Math.round(patch.target));
  if (patch.note !== undefined) data.note = patch.note;
  if (patch.targetDate !== undefined) data.targetDate = patch.targetDate != null ? new Date(patch.targetDate * 1000) : null;
  if (patch.status !== undefined) {
    data.status = patch.status;
    // Un-achieving (or archiving) clears the achievement timestamp; a fresh
    // lazy evaluation re-marks it when the value still meets the target.
    data.achievedAt = null;
  }
  const row = await db.goal.update({ where: { id: goalId }, data });
  return goalRowToDto(row);
}

/** Delete an own goal (hard delete — goals are user intent, not history). */
export async function deleteGoal(userId: string, goalId: string): Promise<{ deleted: true }> {
  const db = getPrismaClient();
  const existing = await db.goal.findFirst({ where: { id: goalId, userId }, select: { id: true } });
  if (!existing) throw new AppError("not_found", "Goal not found.", 404);
  await db.goal.delete({ where: { id: goalId } });
  return { deleted: true };
}

/** Minimal active-goal facts for the command center (no full views). */
export async function getActiveGoalActionFacts(db: ReturnType<typeof getPrismaClient>, userId: string, now: number): Promise<Array<{ id: string; metric: string; label: string; target: number; progress: number | null; etaAt: number | null; targetDate: number | null; achievedAt: Date | null; createdAt: Date }>> {
  const [rows, facts] = await Promise.all([
    db.goal.findMany({ where: { userId, status: "active" }, orderBy: { createdAt: "desc" } }),
    getGoalFacts(db, userId, now),
  ]);
  return rows.map((row) => {
    const view = buildGoalView(goalRowToDto(row), facts, now);
    const meta = GOAL_METRICS[row.metric as GoalMetricId];
    return {
      id: row.id,
      metric: row.metric,
      label: meta?.label ?? row.metric,
      target: Number(row.target),
      progress: view.progress,
      etaAt: view.projection.etaAt,
      targetDate: sec(row.targetDate),
      achievedAt: row.achievedAt,
      createdAt: row.createdAt,
    };
  });
}
