import { getPrismaClient } from "@tornscope/database";
import { getSetting, setSetting } from "@tornscope/database";
import { logger } from "./env.js";

/**
 * Deterministic maintenance: abandoned anonymous profile cleanup and
 * expired/revoked session cleanup.
 *
 * A guest profile is deleted only when ALL hold:
 *   - role "user" (never owner, never the demo dataset)
 *   - no active API credential
 *   - no Torn account (never synced anything real)
 *   - no personal history rows at all (money/drugs/travel/combat/crime/
 *     timeline/networth/consumption/rehab/stats)
 *   - no active (non-revoked) session
 *   - newest activity (session lastSeenAt / user update) older than the
 *     retention window
 *
 * Conservative by construction: any row that cannot be proven empty is kept.
 */

export interface MaintenanceOptions {
  guestRetentionDays: number;
  revokedSessionRetentionDays: number;
  maxGuestsPerRun?: number;
}

export interface MaintenanceResult {
  guestsDeleted: number;
  sessionsDeleted: number;
  skipped: boolean;
}

const HISTORY_TABLES = [
  "moneyEvents",
  "drugEvents",
  "travelEvents",
  "travelItemEvents",
  "combatEvents",
  "crimeEvents",
  "timelineEvents",
  "networthSnapshots",
  "consumptionEvents",
  "rehabEvents",
  "personalStatSnapshots",
  "factionArmoryEvents",
] as const;

/** Pure eligibility check shared by the worker and tests. */
export function isGuestCleanupEligible(profile: {
  role: string;
  isDemo: boolean;
  hasActiveCredential: boolean;
  hasTornAccount: boolean;
  hasAnyHistory: boolean;
  hasActiveSession: boolean;
  lastActivityAt: number;
}, nowMs: number, retentionDays: number): boolean {
  if (profile.role !== "user" || profile.isDemo) return false;
  if (profile.hasActiveCredential) return false;
  if (profile.hasTornAccount) return false;
  if (profile.hasAnyHistory) return false;
  if (profile.hasActiveSession) return false;
  return nowMs - profile.lastActivityAt >= retentionDays * 86_400_000;
}

export async function runMaintenance(opts: MaintenanceOptions): Promise<MaintenanceResult> {
  const db = getPrismaClient();

  // Expired/revoked sessions: revoke older than the retention window.
  const sessionCutoff = new Date(Date.now() - Math.max(opts.revokedSessionRetentionDays, 1) * 86_400_000);
  const sessionsDeleted = await db.userSession.deleteMany({
    where: {
      OR: [
        { revokedAt: { not: null, lt: sessionCutoff } },
        { lastSeenAt: { lt: sessionCutoff } },
      ],
    },
  });

  const dbAny = db as unknown as Record<string, { count: (args: { where: { userId: string } }) => Promise<number> }>;
  const hasAnyHistory = async (userId: string): Promise<boolean> => {
    for (const table of HISTORY_TABLES) {
      const model = dbAny[table];
      if (!model) continue;
      if ((await model.count({ where: { userId } })) > 0) return true;
    }
    // FactionMembership rows are personal projections too.
    if ((await db.factionMembership.count({ where: { userId } })) > 0) return true;
    return false;
  };

  const cutoff = new Date(Date.now() - opts.guestRetentionDays * 86_400_000);
  const candidates = await db.user.findMany({
    where: {
      role: "user",
      isDemo: false,
      updatedAt: { lt: cutoff },
      tornAccount: null,
      sessions: { none: { revokedAt: null } },
      apiCredential: null,
    },
    select: { id: true },
    take: opts.maxGuestsPerRun ?? 200,
  });

  let guestsDeleted = 0;
  for (const candidate of candidates) {
    if (await hasAnyHistory(candidate.id)) continue;
    await db.userSession.deleteMany({ where: { userId: candidate.id } });
    await db.appSetting.deleteMany({ where: { userId: candidate.id } });
    await db.user.delete({ where: { id: candidate.id } });
    guestsDeleted += 1;
  }

  return { guestsDeleted, sessionsDeleted: sessionsDeleted.count, skipped: false };
}

/** Run at most once per day from the scheduler tick. */
const MAINTENANCE_FLAG = "maintenance_last_run";

export async function maybeRunDailyMaintenance(): Promise<MaintenanceResult | null> {
  const db = getPrismaClient();
  const last = await getSetting<number>(db, MAINTENANCE_FLAG, "");
  const now = Date.now();
  const lastNum = typeof last === "number" ? last : Number(last ?? 0);
  if (Number.isFinite(lastNum) && lastNum > 0 && now - lastNum < 24 * 3600_000) return null;
  await setSetting(db, MAINTENANCE_FLAG, now, "");
  try {
    const result = await runMaintenance({
      guestRetentionDays: Number(process.env.GUEST_PROFILE_RETENTION_DAYS ?? 60),
      revokedSessionRetentionDays: 7,
    });
    logger.info({ guestsDeleted: result.guestsDeleted, sessionsDeleted: result.sessionsDeleted }, "maintenance cleanup ran");
    return result;
  } catch (err) {
    logger.error({ err: (err as Error).message }, "maintenance cleanup failed");
    return null;
  }
}
