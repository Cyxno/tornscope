import type { PrismaClientType } from "../client.js";

/**
 * Profile identity & reuse repository.
 *
 * The profile-reuse invariant is: one real tornId -> one non-demo TornScope
 * profile. When a browser validates an API key whose Torn identity already
 * has a profile, the browser is offered a LINK to that profile instead of a
 * duplicate import. These helpers centralize the lookup, the history summary
 * shown in the linking dialog, and the conservative empty-guest cleanup.
 */

export interface ProfileHistorySummary {
  earliestAt: Date | null;
  timelineEvents: number;
  moneyEvents: number;
  drugEvents: number;
  crimeEvents: number;
  combatEvents: number;
  travelTrips: number;
}

/** Row counts that decide whether a profile carries meaningful history. */
export async function getProfileHistorySummary(db: PrismaClientType, userId: string): Promise<ProfileHistorySummary> {
  const [timeline, money, drugs, crimes, combat, trips, earliest] = await Promise.all([
    db.timelineEvent.count({ where: { userId } }),
    db.moneyEvent.count({ where: { userId } }),
    db.drugEvent.count({ where: { userId } }),
    db.crimeEvent.count({ where: { userId } }),
    db.combatEvent.count({ where: { userId } }),
    db.travelEvent.count({ where: { userId } }),
    db.timelineEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
  ]);
  return {
    earliestAt: earliest?.occurredAt ?? null,
    timelineEvents: timeline,
    moneyEvents: money,
    drugEvents: drugs,
    crimeEvents: crimes,
    combatEvents: combat,
    travelTrips: trips,
  };
}

export interface ExistingProfileMatch {
  /** TornScope profile (User.id) that already owns this Torn identity. */
  userId: string;
  displayName: string;
  tornId: number;
  tornName: string;
  level: number | null;
  factionName: string | null;
  isDemo: boolean;
  storedAccess: { level: number | null; type: string | null } | null;
  history: ProfileHistorySummary;
}

/**
 * Find the non-demo profile that owns a Torn identity. Demo profiles are
 * excluded by the TornAccount.isDemo flag AND the User.isDemo flag — a real
 * key can never link, merge or attach to the shared synthetic dataset.
 */
export async function findNonDemoProfileByTornId(db: PrismaClientType, tornId: number): Promise<ExistingProfileMatch | null> {
  const account = await db.tornAccount.findFirst({
    where: { tornId, isDemo: false, user: { isDemo: false } },
    include: {
      user: { include: { apiCredential: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!account) return null;

  let factionName: string | null = null;
  if (account.factionId) {
    const faction = await db.faction.findUnique({ where: { id: account.factionId }, select: { name: true } });
    factionName = faction?.name ?? null;
  }

  const credential = account.user.apiCredential;
  return {
    userId: account.userId,
    displayName: account.user.displayName,
    tornId: account.tornId,
    tornName: account.name,
    level: account.level,
    factionName,
    isDemo: account.user.isDemo,
    storedAccess:
      credential && !credential.revokedAt ? { level: credential.accessLevel, type: credential.accessType } : null,
    history: await getProfileHistorySummary(db, account.userId),
  };
}

/** True when a profile cannot hold any history: never connected and never synced. */
export async function profileIsEmpty(db: PrismaClientType, userId: string): Promise<boolean> {
  const [account, credential] = await Promise.all([
    db.tornAccount.findUnique({ where: { userId }, select: { id: true } }),
    db.apiCredential.findUnique({ where: { userId }, select: { id: true } }),
  ]);
  return account === null && credential === null;
}

/**
 * Delete a profile that is provably empty (no Torn identity, no credential —
 * therefore no synced history, which only ever comes from a credential).
 * Used after linking a fresh guest session to an existing profile, so the
 * throwaway guest does not accumulate. Returns true when deleted.
 */
export async function deleteEmptyProfile(db: PrismaClientType, userId: string): Promise<boolean> {
  const target = await db.user.findUnique({ where: { id: userId }, select: { role: true, isDemo: true } });
  if (!target) return false;
  if (target.role === "owner" || target.isDemo) return false;
  if (!(await profileIsEmpty(db, userId))) return false;
  await db.appSetting.deleteMany({ where: { userId } });
  await db.user.delete({ where: { id: userId } });
  return true;
}
