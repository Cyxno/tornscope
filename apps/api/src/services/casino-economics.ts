import type { PrismaClientType } from "@tornscope/database";

export interface CasinoEconomicsRow {
  activityType: string;
  subtype: string | null;
  outcome: string | null;
  cashInput: bigint | null;
  cashReward: bigint | null;
  netValue: bigint | null;
}

/** Fetch all casino rows for a user window (bounded by the composite index). */
export async function loadCasinoRows(
  db: PrismaClientType,
  userId: string,
  fromDate: Date,
  toDate: Date,
): Promise<CasinoEconomicsRow[]> {
  return db.activityEvent.findMany({
    where: { userId, domain: "casino", occurredAt: { gte: fromDate, lte: toDate } },
    select: { activityType: true, subtype: true, outcome: true, cashInput: true, cashReward: true, netValue: true },
  });
}
