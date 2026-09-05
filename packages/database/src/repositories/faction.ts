import { Prisma } from "../generated/client/client.js";
import type { PrismaClientType } from "../client.js";

/**
 * Faction analytics repositories: ranked wars, chains, organized crimes and
 * faction bank balance snapshots. All upserts key on stable Torn identifiers
 * (war id / chain id / OC id) so repeated runs update in place and history is
 * permanent once stored.
 */

export interface RankedWarInput {
  tornWarId: number;
  factionId: number;
  opponentFactionId: number | null;
  opponentName: string | null;
  startedAt: Date;
  endedAt: Date | null;
  winnerFactionId: number | null;
  targetScore: number | null;
  ourScore: number | null;
  opponentScore: number | null;
  ourChain: number | null;
  opponentChain: number | null;
  raw: object;
}

export async function upsertRankedWar(db: PrismaClientType, war: RankedWarInput): Promise<void> {
  await db.rankedWar.upsert({
    where: { tornWarId: war.tornWarId },
    create: { ...war, raw: war.raw as Prisma.InputJsonValue },
    update: {
      opponentFactionId: war.opponentFactionId,
      opponentName: war.opponentName,
      startedAt: war.startedAt,
      endedAt: war.endedAt,
      winnerFactionId: war.winnerFactionId,
      targetScore: war.targetScore,
      ourScore: war.ourScore,
      opponentScore: war.opponentScore,
      ourChain: war.ourChain,
      opponentChain: war.opponentChain,
      raw: war.raw as Prisma.InputJsonValue,
    },
  });
}

export interface FactionChainInput {
  factionId: number;
  chainId: number;
  chain: number;
  respect: number | null;
  startedAt: Date;
  endedAt: Date;
}

export async function upsertFactionChain(db: PrismaClientType, userId: string, chain: FactionChainInput): Promise<void> {
  await db.factionChain.upsert({
    where: { userId_chainId: { userId, chainId: chain.chainId } },
    create: { userId, ...chain },
    update: { chain: chain.chain, respect: chain.respect, startedAt: chain.startedAt, endedAt: chain.endedAt, factionId: chain.factionId },
  });
}

export interface OrganizedCrimeInput {
  factionId: number;
  ocId: number;
  name: string;
  difficulty: number | null;
  status: string;
  createdAt: Date | null;
  planningAt: Date | null;
  executedAt: Date | null;
  readyAt: Date | null;
  expiredAt: Date | null;
  rewards: unknown;
  slots: unknown;
}

export async function upsertOrganizedCrime(db: PrismaClientType, userId: string, oc: OrganizedCrimeInput): Promise<void> {
  const json = (v: unknown) => (v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue));
  await db.organizedCrime.upsert({
    where: { userId_ocId: { userId, ocId: oc.ocId } },
    create: {
      userId,
      factionId: oc.factionId,
      ocId: oc.ocId,
      name: oc.name,
      difficulty: oc.difficulty,
      status: oc.status,
      createdAt: oc.createdAt,
      planningAt: oc.planningAt,
      executedAt: oc.executedAt,
      readyAt: oc.readyAt,
      expiredAt: oc.expiredAt,
      rewards: json(oc.rewards),
      slots: json(oc.slots),
    },
    update: {
      name: oc.name,
      difficulty: oc.difficulty,
      status: oc.status,
      createdAt: oc.createdAt,
      planningAt: oc.planningAt,
      executedAt: oc.executedAt,
      readyAt: oc.readyAt,
      expiredAt: oc.expiredAt,
      rewards: json(oc.rewards),
      slots: json(oc.slots),
      factionId: oc.factionId,
    },
  });
}

export interface FactionBalanceSnapshotInput {
  factionId: number;
  money: bigint | null;
  points: number | null;
  scope: number | null;
  members: unknown;
  capturedAt: Date;
}

export async function upsertFactionBalanceSnapshot(db: PrismaClientType, userId: string, snapshot: FactionBalanceSnapshotInput): Promise<void> {
  await db.factionBalanceSnapshot.create({
    data: {
      userId,
      factionId: snapshot.factionId,
      money: snapshot.money,
      points: snapshot.points,
      scope: snapshot.scope,
      members: (snapshot.members ?? undefined) as never,
      capturedAt: snapshot.capturedAt,
    },
  });
}
