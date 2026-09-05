import { Prisma } from "../generated/client/client.js";
import type { PrismaClientType } from "../client.js";
import type {
  ConsumptionEventInput,
  CrimeEventInput,
  DrugEventInput,
  MoneyEventInput,
  RehabEventInput,
  TimelineEventInput,
  TravelItemEventInput,
  TravelTransitionInput,
} from "../normalizers/logs.js";

/**
 * Ingestion repositories. All writes are idempotent: unique constraints on
 * (userId, source, sourceRef) let workers re-run or overlap without creating
 * duplicates.
 */

export async function insertDrugEvents(db: PrismaClientType, userId: string, events: DrugEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.drugEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      drugItemId: e.drugItemId,
      drugName: e.drugName,
      outcome: e.outcome,
      source: "torn_log",
      sourceRef: e.sourceRef,
      raw: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function insertConsumptionEvents(db: PrismaClientType, userId: string, events: ConsumptionEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.consumptionEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      itemId: e.itemId,
      itemName: e.itemName,
      category: e.category,
      quantity: e.quantity,
      unitValue: e.unitValue,
      totalValue: e.totalValue,
      valuationMethod: e.valuationMethod,
      provenance: e.provenance,
      source: e.source,
      sourceRef: e.sourceRef,
      metadata: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function insertCrimeEvents(db: PrismaClientType, userId: string, events: CrimeEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.crimeEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      crimeId: e.crimeId,
      crimeName: e.crimeName,
      crimeCategory: e.crimeCategory,
      success: e.success,
      nerveUsed: e.nerveUsed,
      moneyDelta: e.moneyDelta,
      itemsValue: e.itemsValue,
      jailSeconds: e.jailSeconds,
      hospitalSeconds: e.hospitalSeconds,
      skillGain: e.skillGain,
      sourceRef: e.sourceRef,
      metadata: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/** Combat event from the /v2/user/attacks endpoint (source torn_api). */
export interface CombatEventInput {
  occurredAt: Date;
  attackId: number;
  direction: "outgoing" | "incoming";
  opponentId: number | null;
  opponentName: string | null;
  result: string;
  respectDelta: number | null;
  modifiers: Record<string, unknown> | null;
  raw: unknown;
}

export async function insertCombatEvents(db: PrismaClientType, userId: string, events: CombatEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.combatEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      direction: e.direction,
      opponentId: e.opponentId,
      opponentName: e.opponentName,
      result: e.result,
      respectDelta: e.respectDelta,
      modifiers: e.modifiers === null ? Prisma.JsonNull : (e.modifiers as Prisma.InputJsonValue),
      sourceRef: `attack:${e.attackId}`,
      metadata: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function insertRehabEvents(db: PrismaClientType, userId: string, events: RehabEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.rehabEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      rehabPercent: e.rehabPercent,
      cost: e.cost,
      addictionPointsRemoved: e.addictionPointsRemoved,
      source: "torn_log",
      sourceRef: e.sourceRef,
      raw: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function insertTravelTransitions(db: PrismaClientType, userId: string, events: TravelTransitionInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.travelTransition.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      type: e.type,
      country: e.country,
      countryId: e.countryId,
      source: "torn_log",
      sourceRef: e.sourceRef,
      metadata: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function insertTravelItemEvents(db: PrismaClientType, userId: string, events: TravelItemEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.travelItemEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      destination: e.destination,
      category: e.category,
      itemId: e.itemId,
      itemName: e.itemName,
      quantity: e.quantity,
      unitCost: e.unitCost,
      totalCost: e.totalCost,
      source: "torn_log",
      sourceRef: e.sourceRef,
      raw: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function insertMoneyEvents(db: PrismaClientType, userId: string, events: MoneyEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.moneyEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      category: e.category,
      subcategory: e.subcategory,
      direction: e.direction,
      amount: e.amount,
      source: "torn_log",
      sourceRef: e.sourceRef,
      description: e.description,
      // MoneyEvent stores the raw Torn log under `metadata` (there is no raw column).
      metadata: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

export async function insertTimelineEvents(db: PrismaClientType, userId: string, events: TimelineEventInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const result = await db.timelineEvent.createMany({
    data: events.map((e) => ({
      userId,
      occurredAt: e.occurredAt,
      type: e.type,
      category: e.category,
      title: e.title,
      description: e.description,
      amount: e.amount,
      source: "torn_log",
      sourceRef: e.sourceRef,
      metadata: e.raw === undefined ? Prisma.JsonNull : (e.raw as Prisma.InputJsonValue),
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                  */
/* -------------------------------------------------------------------------- */

export interface UserProfileState {
  level: number;
  rank: string | null;
  factionId: number | null;
  status: unknown;
  raw: unknown;
}

/**
 * Persist a user snapshot only when state changed or the last snapshot is
 * older than an hour, avoiding a snapshot per 5-minute poll with no change.
 */
export async function snapshotUserState(
  db: PrismaClientType,
  userId: string,
  state: UserProfileState,
  now = new Date()
): Promise<boolean> {
  const last = await db.userSnapshot.findFirst({
    where: { userId },
    orderBy: { capturedAt: "desc" },
  });

  const statusJson = state.status === undefined ? Prisma.JsonNull : (state.status as Prisma.InputJsonValue);
  const sameState =
    last &&
    last.level === state.level &&
    last.rank === state.rank &&
    last.factionId === state.factionId;
  const stale = !last || now.getTime() - last.capturedAt.getTime() > 3_600_000;

  if (sameState && !stale) return false;

  await db.userSnapshot.create({
    data: {
      userId,
      capturedAt: now,
      level: state.level,
      rank: state.rank,
      factionId: state.factionId,
      status: statusJson,
      raw: state.raw === undefined ? Prisma.JsonNull : (state.raw as Prisma.InputJsonValue),
    },
  });
  return true;
}

export interface NetworthSnapshotInput {
  capturedAt: Date;
  total: bigint;
  pending: bigint;
  wallet: bigint;
  vault: bigint;
  bookie: bigint;
  cityBank: bigint;
  caymanBank: bigint;
  piggyBank: bigint;
  loans: bigint;
  unpaidFees: bigint;
  inventory: bigint;
  displayCase: bigint;
  bazaar: bigint;
  trades: bigint;
  itemMarket: bigint;
  auctionHouse: bigint;
  enlistedCars: bigint;
  property: bigint;
  stockMarket: bigint;
  company: bigint;
  points: bigint;
  raw: unknown;
}

export async function insertNetworthSnapshot(db: PrismaClientType, userId: string, input: NetworthSnapshotInput): Promise<void> {
  await db.networthSnapshot.upsert({
    where: { userId_capturedAt: { userId, capturedAt: input.capturedAt } },
    create: { userId, ...input, raw: input.raw === undefined ? Prisma.JsonNull : (input.raw as Prisma.InputJsonValue) },
    update: { ...input, raw: input.raw === undefined ? Prisma.JsonNull : (input.raw as Prisma.InputJsonValue) },
  });
}

export async function insertPersonalStatSnapshot(
  db: PrismaClientType,
  userId: string,
  capturedAt: Date,
  stats: Record<string, unknown>,
  networthTotal: bigint | null
): Promise<void> {
  const json = stats as Prisma.InputJsonValue;
  await db.personalStatSnapshot.upsert({
    where: { userId_capturedAt: { userId, capturedAt } },
    create: { userId, capturedAt, stats: json, networthTotal },
    update: { stats: json, networthTotal },
  });
}

/* -------------------------------------------------------------------------- */
/* Faction                                                                    */
/* -------------------------------------------------------------------------- */

export interface FactionBasicInput {
  id: number;
  name: string;
  tag: string | null;
  leaderId: number | null;
  coLeaderId: number | null;
  respect: number | null;
  daysOld: number | null;
  capacity: number | null;
  members: number | null;
  bestChain: number | null;
}

export async function upsertFaction(db: PrismaClientType, faction: FactionBasicInput): Promise<void> {
  await db.faction.upsert({
    where: { id: faction.id },
    create: faction,
    update: {
      name: faction.name,
      tag: faction.tag,
      leaderId: faction.leaderId,
      coLeaderId: faction.coLeaderId,
      respect: faction.respect,
      daysOld: faction.daysOld,
      capacity: faction.capacity,
      members: faction.members,
      bestChain: faction.bestChain,
    },
  });
}

/** Record current faction membership; closes previous membership rows. */
export async function upsertFactionMembership(
  db: PrismaClientType,
  userId: string,
  factionId: number,
  sourceRef: string,
  joinedAt: Date | null,
  now = new Date()
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.factionMembership.updateMany({
      where: { userId, factionId: { not: factionId }, isActive: true },
      data: { isActive: false, leftAt: now },
    });
    const existing = await tx.factionMembership.findFirst({
      where: { userId, factionId, isActive: true },
    });
    if (!existing) {
      await tx.factionMembership.create({
        data: { userId, factionId, joinedAt, isActive: true, sourceRef },
      });
    }
  });
}

export async function insertFactionSnapshot(
  db: PrismaClientType,
  userId: string,
  factionId: number,
  capturedAt: Date,
  members: number | null,
  respect: number | null,
  raw: unknown
): Promise<void> {
  await db.factionSnapshot.upsert({
    where: { userId_capturedAt: { userId, capturedAt } },
    create: { userId, factionId, capturedAt, members, respect, raw: raw === undefined ? Prisma.JsonNull : (raw as Prisma.InputJsonValue) },
    update: { members, respect, raw: raw === undefined ? Prisma.JsonNull : (raw as Prisma.InputJsonValue) },
  });
}

/* -------------------------------------------------------------------------- */
/* Torn account                                                               */
/* -------------------------------------------------------------------------- */

export interface TornAccountUpsert {
  tornId: number;
  name: string;
  level: number;
  rank: string | null;
  donatorStatus: number | null;
  gender: string | null;
  property: string | null;
  factionId: number | null;
  status: unknown;
  seenAt: Date;
}

export async function upsertTornAccount(db: PrismaClientType, userId: string, account: TornAccountUpsert): Promise<void> {
  const existing = await db.tornAccount.findUnique({ where: { userId } });
  if (!existing) {
    await db.tornAccount.create({
      data: {
        userId,
        tornId: account.tornId,
        name: account.name,
        level: account.level,
        rank: account.rank,
        donatorStatus: account.donatorStatus,
        gender: account.gender,
        property: account.property,
        factionId: account.factionId,
        status: account.status === undefined ? Prisma.JsonNull : (account.status as Prisma.InputJsonValue),
        firstSeenAt: account.seenAt,
        lastSeenAt: account.seenAt,
      },
    });
    return;
  }
  await db.tornAccount.update({
    where: { userId },
    data: {
      tornId: account.tornId,
      name: account.name,
      level: account.level,
      rank: account.rank,
      donatorStatus: account.donatorStatus,
      gender: account.gender,
      property: account.property,
      factionId: account.factionId,
      status: account.status === undefined ? Prisma.JsonNull : (account.status as Prisma.InputJsonValue),
      lastSeenAt: account.seenAt,
    },
  });
}
