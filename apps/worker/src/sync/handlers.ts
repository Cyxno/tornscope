import type { TornEndpoints } from "@tornscope/torn-api";
import type { SyncResource } from "@tornscope/shared";
import {
  encryptionFromEnv,
  insertDrugEvents,
  insertMoneyEvents,
  insertNetworthSnapshot,
  insertPersonalStatSnapshot,
  insertRehabEvents,
  insertTimelineEvents,
  insertTravelEvents,
  insertTravelItemEvents,
  insertFactionSnapshot,
  loadItemNameMap,
  normalizeLogEntry,
  normalizeTornEvent,
  setLogCategories as cacheLogCategories,
  snapshotUserState,
  upsertCatalogEntries,
  upsertFaction,
  upsertFactionMembership,
  upsertTornAccount,
  getLogCategories,
} from "@tornscope/database";
import { getWorkerContext } from "../context.js";
import { logger } from "../env.js";

/**
 * Sync handlers. Each handler returns the number of records collected.
 *
 * Incremental log-based resources use sync_state.lastTimestamp as cursor and
 * rely on unique constraints (userId, source, sourceRef) for deduplication:
 * re-processing or overlapping ranges is always safe.
 *
 * The log normalizer routes by the entry's own `details.category` title
 * (resolved against the /torn/logcategories catalog at runtime), so no
 * undocumented category ids are hardcoded.
 */

export interface SyncHandlerArgs {
  userId: string;
  apiKey: string;
  torn: TornEndpoints;
  lastTimestamp: bigint | null;
}

export type SyncHandlerResult = { records: number; lastTimestamp?: bigint | null };

type SyncHandler = (args: SyncHandlerArgs) => Promise<SyncHandlerResult>;

/* -------------------------------------------------------------------------- */
/* torn_catalog: item names + market prices, log category catalog             */
/* -------------------------------------------------------------------------- */

export const syncTornCatalog: SyncHandler = async ({ torn }) => {
  const ctx = getWorkerContext();
  let records = 0;

  const catalog = await torn.tornItems("All");
  await upsertCatalogEntries(
    ctx.db,
    catalog.map((item) => ({
      itemId: item.id,
      name: item.name,
      type: item.type,
      marketPrice: item.value?.market_price !== undefined ? BigInt(item.value.market_price) : null,
    }))
  );
  records += catalog.length;

  const categories = await torn.tornLogCategories();
  await cacheLogCategories(
    ctx.db,
    categories.map((c) => ({ id: c.id, title: c.title }))
  );
  records += categories.length;

  return { records };
};

/* -------------------------------------------------------------------------- */
/* profile: identity, state snapshot, faction membership                      */
/* -------------------------------------------------------------------------- */

export const syncProfile: SyncHandler = async ({ userId, torn }) => {
  const ctx = getWorkerContext();
  const now = new Date();
  let records = 0;

  const profile = await torn.userProfile();
  const p = profile.profile;

  await upsertTornAccount(ctx.db, userId, {
    tornId: p.id,
    name: p.name,
    level: p.level,
    rank: p.rank ?? null,
    donatorStatus: p.donator_status ?? null,
    gender: p.gender ?? null,
    property: p.property?.name ?? null,
    factionId: p.faction_id ?? null,
    status: p.status,
    seenAt: now,
  });
  records += 1;

  await snapshotUserState(
    ctx.db,
    userId,
    {
      level: p.level,
      rank: p.rank ?? null,
      factionId: p.faction_id ?? null,
      status: p.status,
      raw: p,
    },
    now
  );

  if (p.faction_id !== null && p.faction_id !== undefined) {
    try {
      const faction = await torn.factionBasic();
      const f = faction.basic;
      if (f.id === p.faction_id) {
        await upsertFaction(ctx.db, {
          id: f.id,
          name: f.name,
          tag: (f.tag as string | undefined) ?? null,
          leaderId: (f.leader_id as number | undefined) ?? null,
          coLeaderId: (f.co_leader_id as number | null | undefined) ?? null,
          respect: (f.respect as number | undefined) ?? null,
          daysOld: (f.days_old as number | undefined) ?? null,
          capacity: (f.capacity as number | undefined) ?? null,
          members: (f.members as number | undefined) ?? null,
          bestChain: (f.best_chain as number | undefined) ?? null,
        });
        await insertFactionSnapshot(ctx.db, userId, f.id, now, f.members ?? null, f.respect ?? null, f);
        records += 2;
      }
    } catch (err) {
      // Faction details need permissions the key may not grant; profile sync
      // must not fail because of it.
      logger.warn({ err: (err as Error).message, userId }, "faction basic fetch failed during profile sync");
    }
    await upsertFactionMembership(ctx.db, userId, p.faction_id, `profile:${p.id}`, null, now);
  }

  return { records };
};

/* -------------------------------------------------------------------------- */
/* networth: exact Torn-provided snapshot with category breakdown             */
/* -------------------------------------------------------------------------- */

export const syncNetworth: SyncHandler = async ({ userId, torn }) => {
  const ctx = getWorkerContext();
  const result = await torn.userNetworth();
  const nw = result.networth;

  await insertNetworthSnapshot(ctx.db, userId, {
    capturedAt: new Date(nw.timestamp * 1000),
    total: BigInt(nw.total),
    pending: BigInt(nw.money.pending),
    wallet: BigInt(nw.money.wallet),
    vault: BigInt(nw.money.vault),
    bookie: BigInt(nw.money.bookie),
    cityBank: BigInt(nw.money.city_bank),
    caymanBank: BigInt(nw.money.cayman_bank),
    piggyBank: BigInt(nw.money.piggy_bank),
    loans: BigInt(nw.money.loans),
    unpaidFees: BigInt(nw.money.unpaid_fees),
    inventory: BigInt(nw.items.inventory),
    displayCase: BigInt(nw.items.display_case),
    bazaar: BigInt(nw.items.bazaar),
    trades: BigInt(nw.items.trades),
    itemMarket: BigInt(nw.items.item_market),
    auctionHouse: BigInt(nw.items.auction_house),
    enlistedCars: BigInt(nw.items.enlisted_cars),
    property: BigInt(nw.assets.property),
    stockMarket: BigInt(nw.assets.stock_market),
    company: BigInt(nw.assets.company),
    points: BigInt(nw.points),
    raw: nw,
  });

  return { records: 1 };
};

/* -------------------------------------------------------------------------- */
/* personal_stats                                                             */
/* -------------------------------------------------------------------------- */

export const syncPersonalStats: SyncHandler = async ({ userId, torn }) => {
  const ctx = getWorkerContext();
  const result = await torn.userPersonalStats("all");

  const latestNetworth = await ctx.db.networthSnapshot.findFirst({
    where: { userId },
    orderBy: { capturedAt: "desc" },
    select: { total: true },
  });

  await insertPersonalStatSnapshot(ctx.db, userId, new Date(), result.personalstats, latestNetworth?.total ?? null);
  return { records: 1 };
};

/* -------------------------------------------------------------------------- */
/* Log-based resources                                                        */
/* -------------------------------------------------------------------------- */

/** Resolve log category ids whose titles match any keyword. */
async function resolveCategoryIds(keywords: readonly string[]): Promise<number[]> {
  const ctx = getWorkerContext();
  let categories = await getLogCategories(ctx.db);
  if (!categories) {
    // Catalog not synced yet - bootstrap it inline so the first sync works.
    await syncTornCatalog({ userId: "", apiKey: "", torn: ctx.torn(await getCurrentApiKey()), lastTimestamp: null });
    categories = await getLogCategories(ctx.db);
  }
  if (!categories) return [];
  return categories
    .filter((c) => keywords.some((kw) => c.title.toLowerCase().includes(kw)))
    .map((c) => c.id);
}

async function getCurrentApiKey(): Promise<string> {
  const ctx = getWorkerContext();
  const credential = await ctx.db.apiCredential.findFirst({
    where: { revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!credential) return "";
  return encryptionFromEnv().decrypt(credential);
}

/**
 * Incremental log sync: fetch pages for the matched categories from the
 * cursor, normalize, and insert all typed writes. Dedup on
 * (userId, source, sourceRef) makes reprocessing safe.
 */
async function syncLogsByCategories(args: SyncHandlerArgs, categoryIds: number[]): Promise<SyncHandlerResult> {
  const ctx = getWorkerContext();
  const itemNameById = await loadItemNameMap(ctx.db);

  const from =
    args.lastTimestamp !== null
      ? Number(args.lastTimestamp)
      : Math.floor(Date.now() / 1000) - ctx.initialHistoryDays * 86_400;

  let records = 0;
  let maxTimestamp = args.lastTimestamp !== null ? Number(args.lastTimestamp) : 0;

  for (const category of categoryIds) {
    await args.torn.iterateUserLogs(
      { category, from, limit: 100 },
      async (logs) => {
        if (logs.length === 0) return;
        for (const log of logs) {
          const normalized = normalizeLogEntry(log, { itemNameById });
          await insertTimelineEvents(ctx.db, args.userId, normalized.timelineEvents);
          await insertDrugEvents(ctx.db, args.userId, normalized.drugEvents);
          await insertRehabEvents(ctx.db, args.userId, normalized.rehabEvents);
          await insertTravelEvents(ctx.db, args.userId, normalized.travelEvents);
          await insertTravelItemEvents(ctx.db, args.userId, normalized.travelItemEvents);
          await insertMoneyEvents(ctx.db, args.userId, normalized.moneyEvents);
          records += 1;
          if (log.timestamp > maxTimestamp) maxTimestamp = log.timestamp;
        }
      },
      { maxPages: 400 }
    );
  }

  return { records, lastTimestamp: maxTimestamp > 0 ? BigInt(maxTimestamp) : null };
}

export const syncDrugLogs: SyncHandler = async (args) => syncLogsByCategories(args, await resolveCategoryIds(["drug"]));

export const syncRehabLogs: SyncHandler = async (args) => syncLogsByCategories(args, await resolveCategoryIds(["rehab", "rehabilitation"]));

export const syncTravelLogs: SyncHandler = async (args) => syncLogsByCategories(args, await resolveCategoryIds(["travel", "abroad", "fly", "flight"]));

export const syncMoneyLogs: SyncHandler = async (args) =>
  syncLogsByCategories(args, await resolveCategoryIds([
    "trade", "money", "bazaar", "bank", "casino", "stock", "salary", "points", "auction", "crime", "mug", "payout",
  ]));

/* -------------------------------------------------------------------------- */
/* events (Torn events -> timeline)                                           */
/* -------------------------------------------------------------------------- */

export const syncEvents: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const from =
    args.lastTimestamp !== null
      ? Number(args.lastTimestamp)
      : Math.floor(Date.now() / 1000) - ctx.initialHistoryDays * 86_400;

  let records = 0;
  let maxTimestamp = args.lastTimestamp !== null ? Number(args.lastTimestamp) : 0;

  await args.torn.iterateUserEvents(
    { from, limit: 100 },
    async (events) => {
      if (events.length === 0) return;
      await insertTimelineEvents(ctx.db, args.userId, events.map((event) => normalizeTornEvent(event)));
      records += events.length;
      for (const event of events) {
        if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp;
      }
    },
    { maxPages: 200 }
  );

  return { records, lastTimestamp: maxTimestamp > 0 ? BigInt(maxTimestamp) : null };
};

/* -------------------------------------------------------------------------- */
/* faction_basic                                                              */
/* -------------------------------------------------------------------------- */

export const syncFactionBasic: SyncHandler = async ({ userId, torn }) => {
  const ctx = getWorkerContext();
  const account = await ctx.db.tornAccount.findUnique({ where: { userId } });
  if (!account?.factionId) return { records: 0 };

  const faction = await torn.factionBasic();
  const f = faction.basic;
  await upsertFaction(ctx.db, {
    id: f.id,
    name: f.name,
    tag: (f.tag as string | undefined) ?? null,
    leaderId: (f.leader_id as number | undefined) ?? null,
    coLeaderId: (f.co_leader_id as number | null | undefined) ?? null,
    respect: (f.respect as number | undefined) ?? null,
    daysOld: (f.days_old as number | undefined) ?? null,
    capacity: (f.capacity as number | undefined) ?? null,
    members: (f.members as number | undefined) ?? null,
    bestChain: (f.best_chain as number | undefined) ?? null,
  });
  await insertFactionSnapshot(ctx.db, userId, f.id, new Date(), f.members ?? null, f.respect ?? null, f);
  return { records: 1 };
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export const SYNC_HANDLERS: Record<SyncResource, SyncHandler> = {
  profile: syncProfile,
  personal_stats: syncPersonalStats,
  networth: syncNetworth,
  drugs: syncDrugLogs,
  travel: syncTravelLogs,
  rehab: syncRehabLogs,
  money_logs: syncMoneyLogs,
  events: syncEvents,
  faction_basic: syncFactionBasic,
  torn_catalog: syncTornCatalog,
};
