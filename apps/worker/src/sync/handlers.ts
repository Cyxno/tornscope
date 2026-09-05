import { normalizeDonatorStatus, type TornEndpoints, type BackwardStopReason } from "@tornscope/torn-api";
import type { SyncResource } from "@tornscope/shared";
import {
  encryptionFromEnv,
  insertConsumptionEvents,
  insertDrugEvents,
  insertMoneyEvents,
  insertNetworthSnapshot,
  insertPersonalStatSnapshot,
  insertRehabEvents,
  insertTimelineEvents,
  insertTravelTransitions,
  insertTravelItemEvents,
  insertFactionSnapshot,
  loadItemIdByName,
  loadItemNameMap,
  loadItemTypeMap,
  loadMarketPrices,
  normalizeLogEntry,
  normalizeTornEvent,
  setLogCategories as cacheLogCategories,
  snapshotUserState,
  upsertCatalogEntries,
  upsertFaction,
  upsertFactionMembership,
  upsertTornAccount,
  getLogCategories,
  assembleTripsFromTransitions,
} from "@tornscope/database";
import { getWorkerContext } from "../context.js";
import { logger } from "../env.js";

/**
 * Sync handlers. Each handler returns the number of records collected.
 *
 * Incremental log-based resources use sync_state.lastTimestamp as cursor and
 * rely on unique constraints (userId, source, sourceRef) for deduplication:
 * re-processing or overlapping ranges is always safe. Handlers report
 * progress through `onProgress(cumulativeRecords)` after every page so the
 * Sync Status view shows live backfill state and crashed runs are detected
 * by heartbeat instead of a fixed timeout.
 */

export interface SyncHandlerArgs {
  userId: string;
  apiKey: string;
  torn: TornEndpoints;
  lastTimestamp: bigint | null;
  /** Report cumulative records successfully written so far. */
  onProgress?: (recordsSoFar: number) => void;
}

export type SyncHandlerResult = {
  records: number;
  lastTimestamp?: bigint | null;
  /** Why the historical backward walk stopped (coverage reporting). */
  stopReason?: BackwardStopReason | "api_error";
  /** Oldest source timestamp seen during the walk. */
  sourceEarliestAt?: bigint | null;
};

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
    donatorStatus: normalizeDonatorStatus(p.donator_status),
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
 * Incremental + historical log sync.
 *
 * Torn's /user/log returns the NEWEST page first and exposes older pages
 * only through `links.prev` — the old forward-only pagination silently
 * truncated every category to its first page (100 newest rows). We now walk
 * BACKWARD from the newest page down to the boundary:
 * - initial backfill (lastTimestamp null): boundary = now - history days
 * - incremental (lastTimestamp set): boundary = last cursor timestamp
 * Insertion is idempotent ((userId, source, sourceRef) unique), so walking
 * over already-stored rows is always safe.
 *
 * The result reports WHY the walk stopped plus the oldest source timestamp
 * observed, so Sync Status can show real historical coverage instead of
 * claiming caught_up merely because a page completed.
 */
async function syncLogsByCategories(args: SyncHandlerArgs, categoryIds: number[]): Promise<SyncHandlerResult> {
  const ctx = getWorkerContext();
  const [itemNameById, itemTypeById, itemMarketPriceById, itemIdByName] = await Promise.all([
    loadItemNameMap(ctx.db),
    loadItemTypeMap(ctx.db),
    loadMarketPrices(ctx.db),
    loadItemIdByName(ctx.db),
  ]);

  const nowSec = Math.floor(Date.now() / 1000);
  const boundaryTs =
    args.lastTimestamp !== null ? Number(args.lastTimestamp) : nowSec - ctx.initialHistoryDays * 86_400;

  let records = 0;
  let maxTimestamp = args.lastTimestamp !== null ? Number(args.lastTimestamp) : 0;
  const stopReasons: BackwardStopReason[] = [];
  let sourceEarliest: number | null = null;

  for (const category of categoryIds) {
    let categoryRecords = 0;
    const walk = await args.torn.iterateUserLogsBackward(
      { category, from: boundaryTs, limit: 100 },
      async (logs, _metadata) => {
        logger.debug({ userId: args.userId, category, page: logs.length, stage: "page_received" }, "log page received");
        if (logs.length === 0) return;
        for (const log of logs) {
          const normalized = normalizeLogEntry(log, { itemNameById, itemTypeById, itemMarketPriceById, itemIdByName });
          // Each typed insert is its own small idempotent transaction — the
          // cursor is only advanced after every page of this category made
          // it to PostgreSQL, so a crash resumes instead of skipping data.
          await insertTimelineEvents(ctx.db, args.userId, normalized.timelineEvents);
          await insertDrugEvents(ctx.db, args.userId, normalized.drugEvents);
          await insertConsumptionEvents(ctx.db, args.userId, normalized.consumptionEvents);
          await insertRehabEvents(ctx.db, args.userId, normalized.rehabEvents);
          await insertTravelTransitions(ctx.db, args.userId, normalized.travelTransitions);
          await insertTravelItemEvents(ctx.db, args.userId, normalized.travelItemEvents);
          await insertMoneyEvents(ctx.db, args.userId, normalized.moneyEvents);
          categoryRecords += 1;
          if (log.timestamp > maxTimestamp) maxTimestamp = log.timestamp;
        }
        // Heartbeat cumulative totals so long backfills stay visible and a
        // crashed run never advances the cursor past unstored data.
        args.onProgress?.(records + categoryRecords);
      },
      { maxPages: 400, boundaryTs }
    );
    records += categoryRecords;
    stopReasons.push(walk.stopReason);
    if (walk.oldestTimestamp !== null && (sourceEarliest === null || walk.oldestTimestamp < sourceEarliest)) {
      sourceEarliest = walk.oldestTimestamp;
    }
    logger.debug(
      { userId: args.userId, category, pages: walk.pages, stopReason: walk.stopReason, oldest: walk.oldestTimestamp },
      "log category backward walk finished"
    );
  }

  // Trips are assembled from transitions, never written per log — rebuild
  // them after any travel-domain fetch so new flights close out.
  if (categoryIds.length > 0) {
    const assembly = await assembleTripsFromTransitions(ctx.db, args.userId);
    if (assembly.trips > 0) {
      logger.debug({ userId: args.userId, trips: assembly.trips, unmatched: assembly.unmatchedTransitions }, "travel trips assembled");
    }
  }

  return {
    records,
    lastTimestamp: maxTimestamp > 0 ? BigInt(maxTimestamp) : null,
    stopReason: aggregateStopReason(stopReasons),
    sourceEarliestAt: sourceEarliest !== null ? BigInt(sourceEarliest) : null,
  };
}

/**
 * Aggregate per-category stop reasons into one resource-level reason,
 * prioritizing incompleteness: any incomplete category must be visible.
 */
export function aggregateStopReason(reasons: BackwardStopReason[]): BackwardStopReason {
  if (reasons.length === 0) return "source_exhausted";
  if (reasons.includes("max_pages")) return "max_pages";
  if (reasons.includes("cursor_stalled")) return "cursor_stalled";
  if (reasons.includes("callback_stop")) return "callback_stop";
  if (reasons.includes("history_boundary_reached")) return "history_boundary_reached";
  return "source_exhausted";
}

// Consumable item use (EDVD, energy drinks, candy, boosters, medical items
// and other consumables) is filed under the dedicated "Item use ..." log
// categories. They are fetched with the drugs resource so consumption
// economics cover every consumable, not only drugs.
export const syncDrugLogs: SyncHandler = async (args) => syncLogsByCategories(args, await resolveCategoryIds(["drug", "item use"]));

// Torn has NO rehab log category: rehab visits are filed under the "Travel"
// category with the title "Rehab". The keyword list therefore mirrors the
// travel resource; the normalizer routes by title.
export const syncRehabLogs: SyncHandler = async (args) =>
  syncLogsByCategories(args, await resolveCategoryIds(["travel", "abroad", "fly", "flight", "rehab", "rehabilitation"]));

export const syncTravelLogs: SyncHandler = async (args) =>
  syncLogsByCategories(args, await resolveCategoryIds(["travel", "abroad", "fly", "flight"]));

// Financial surface. Beyond the obvious money keywords this includes the real
// category names observed in a live 180-day history: "Company", "Job",
// "Property", "Shops", "Item market", "Donator", "Offshore bank", "Piggy
// bank", "Loan". The normalizer decides which entries are actual movements.
export const syncMoneyLogs: SyncHandler = async (args) =>
  syncLogsByCategories(args, await resolveCategoryIds([
    "trade", "money", "bazaar", "bank", "casino", "stock", "salary", "points", "auction", "crime", "mug", "payout",
    "company", "job", "property", "shop", "item market", "donator", "offshore", "piggy", "loan", "upkeep", "faction",
  ]));

/* -------------------------------------------------------------------------- */
/* events (Torn events -> timeline)                                           */
/* -------------------------------------------------------------------------- */

export const syncEvents: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const nowSec = Math.floor(Date.now() / 1000);
  const boundaryTs =
    args.lastTimestamp !== null ? Number(args.lastTimestamp) : nowSec - ctx.initialHistoryDays * 86_400;

  let records = 0;
  let maxTimestamp = args.lastTimestamp !== null ? Number(args.lastTimestamp) : 0;

  const walk = await args.torn.iterateUserEventsBackward(
    { from: boundaryTs, limit: 100 },
    async (events) => {
      if (events.length === 0) return;
      await insertTimelineEvents(ctx.db, args.userId, events.map((event) => normalizeTornEvent(event)));
      records += events.length;
      for (const event of events) {
        if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp;
      }
      args.onProgress?.(records);
    },
    { maxPages: 200, boundaryTs }
  );
  logger.debug({ userId: args.userId, pages: walk.pages, stopReason: walk.stopReason, oldest: walk.oldestTimestamp }, "events backward walk finished");

  return {
    records,
    lastTimestamp: maxTimestamp > 0 ? BigInt(maxTimestamp) : null,
    stopReason: walk.stopReason,
    sourceEarliestAt: walk.oldestTimestamp !== null ? BigInt(walk.oldestTimestamp) : null,
  };
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
