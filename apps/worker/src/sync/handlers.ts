import { TornApiError, normalizeDonatorStatus, type TornEndpoints, type TornRequestParams, type BackwardStopReason, type TornUserAttack } from "@tornscope/torn-api";
import type { KeyCapabilities, SyncResource } from "@tornscope/shared";
import {
  encryptionFromEnv,
  insertConsumptionEvents,
  insertCrimeEvents,
  insertDrugEvents,
  insertMoneyEvents,
  insertNetworthSnapshot,
  insertPersonalStatSnapshot,
  insertBarsSnapshot,
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
  upsertFactionMemberRoster,
  upsertFactionArmoryEvents,
  type FactionArmoryEventInput,
  upsertTornAccount,
  getLogCategories,
  getSyncCategoryState,
  getSyncCategoryStates,
  upsertSyncCategoryState,
  insertCombatEvents,
  assembleTripsFromTransitions,
  upsertFactionBalanceSnapshot,
  upsertFactionChain,
  upsertOrganizedCrime,
  upsertRankedWar,
} from "@tornscope/database";
import { parseArmoryNews } from "@tornscope/database";
import { isCategoryDue, nextCategorySchedule, SCHEDULE_THRESHOLDS } from "./schedule.js";
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
  /** Manual "Sync Now": walk every category, ignoring adaptive nextRunAt. */
  force?: boolean;
  /**
   * Detected key capabilities (null when detection failed). Composite
   * handlers use this to skip sub-fetches the key cannot answer instead of
   * burning Torn quota on guaranteed access-denied responses.
   */
  capabilities?: KeyCapabilities | null;
  onProgress?: (recordsSoFar: number) => void;
}

export type SyncHandlerResult = {
  records: number;
  /** Total Torn API pages fetched during this sync (lightweight-check). */
  pagesWalked?: number;
  lastTimestamp?: bigint | null;
  /** Why the historical backward walk stopped (coverage reporting). */
  stopReason?: BackwardStopReason | "api_error";
  /** Oldest source timestamp seen during the walk. */
  sourceEarliestAt?: bigint | null;
  /** Categories that failed this sync (each recorded in its own state). */
  failedCategories?: number;
  totalCategories?: number;
  /** Adaptive scheduling metrics for this run. */
  categoriesDue?: number;
  categoriesProcessed?: number;
  categoriesSkipped?: number;
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

export const syncProfile: SyncHandler = async ({ userId, torn, capabilities }) => {
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
    // Capability-aware: a key without faction basic access would burn one
    // guaranteed access-denied Torn call here on EVERY profile sync (every
    // 5 minutes) — the single largest avoidable cost of a Limited key on the
    // serialized worker pipeline. Membership is still recorded from the
    // profile payload, which needs no extra permission.
    const canFetchFaction = capabilities ? capabilities.canReadFactionBasic : true;
    if (canFetchFaction) {
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
/* bars                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Energy/happy bar snapshot — the ONLY historical record of bar state (Torn
 * exposes bars live-only). Five-minute cadence captures regen/spend shape at
 * the resolution the energy analytics need (docs/PROGRESSION-ENERGY.md).
 */
export const syncBars: SyncHandler = async ({ userId, torn }) => {
  const ctx = getWorkerContext();
  const result = await torn.userBars();
  const now = new Date();
  await insertBarsSnapshot(ctx.db, userId, {
    capturedAt: now,
    energyCurrent: result.bars.energy.current,
    energyMaximum: result.bars.energy.maximum,
    happyCurrent: result.bars.happy.current,
    happyMaximum: result.bars.happy.maximum,
  });
  return { records: 1 };
};

/* -------------------------------------------------------------------------- */
/* Log-based resources                                                        */
/* -------------------------------------------------------------------------- */

/** A resolvable log category for a resource. */
export interface ResolvedCategory {
  id: number;
  title: string;
}

/** Resolve log categories whose titles match any keyword (catalog-driven). */
async function resolveCategoryIds(userId: string, keywords: readonly string[]): Promise<ResolvedCategory[]> {
  const ctx = getWorkerContext();
  let categories = await getLogCategories(ctx.db);
  if (!categories) {
    // Catalog not synced yet - bootstrap it inline so the first sync works.
    // The catalog is global, but the key that fetches it belongs to THIS
    // job's user: one user's credential must never be spent for another's.
    await syncTornCatalog({ userId: "", apiKey: "", torn: ctx.torn(await getCurrentApiKey(userId)), lastTimestamp: null });
    categories = await getLogCategories(ctx.db);
  }
  if (!categories) return [];
  return categories
    .filter((c) => keywords.some((kw) => c.title.toLowerCase().includes(kw)))
    .map((c) => ({ id: c.id, title: c.title }));
}

/** Decrypt the credential of THIS job's user only (never "any latest key"). */
async function getCurrentApiKey(userId: string): Promise<string> {
  const ctx = getWorkerContext();
  const credential = await ctx.db.apiCredential.findFirst({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!credential) return "";
  return encryptionFromEnv().decrypt(credential);
}

/**
 * Requested history boundary (unix seconds) for a resource-level sync.
 *
 * - Initial backfill (lastTimestamp null): now - initialHistoryDays. The walk
 *   stops at this boundary and only rows INSIDE the window are persisted —
 *   the boundary-crossing page may contain much older rows (a low-volume
 *   category's entire history fits on one page, potentially years back),
 *   and those are filtered out unless explicitly configured otherwise.
 * - Incremental (lastTimestamp set): the last successful cursor. Torn has no
 *   server-side lower-bound filter, so the walk pages down from the newest
 *   page until it reaches the cursor — normally one page, never a deep walk.
 */
export function historyBoundaryTs(lastTimestamp: bigint | null, initialHistoryDays: number, nowSec = Math.floor(Date.now() / 1000)): number {
  return lastTimestamp !== null ? Number(lastTimestamp) : nowSec - initialHistoryDays * 86_400;
}

/**
 * Per-category cursor plan.
 *
 * CURSOR SEMANTICS — a category's stored lastTimestamp means:
 *   "all log rows above this successfully persisted point are known to be
 *    stored" (minus CURSOR_OVERLAP_SECONDS, which the next walk re-fetches
 *    so rows sharing the cursor second can never straddle a page boundary
 *    unnoticed). Dedup via (userId, source, sourceRef) makes the overlap
 *    replay idempotent.
 *
 * It is advanced only AFTER a category's page data has been normalized and
 * inserted; a crash mid-walk leaves the previous cursor intact and the next
 * run replays that category safely. Categories are independent: one failing
 * category never rolls back or blocks another.
 */
export const CURSOR_OVERLAP_SECONDS = 120;

export interface CategoryWalkPlan {
  /** Initial (full window) backfill vs incremental from the own cursor. */
  initial: boolean;
  /** The walk stops when a page's oldest row is at/before this. */
  boundaryTs: number;
  /** Rows older than this are not persisted (initial backfills only). */
  persistFromTs: number;
}

export function planCategoryWalk(lastTimestamp: bigint | null, initialHistoryDays: number, nowSec = Math.floor(Date.now() / 1000)): CategoryWalkPlan {
  if (lastTimestamp === null) {
    const boundaryTs = Math.max(0, nowSec - initialHistoryDays * 86_400);
    return { initial: true, boundaryTs, persistFromTs: boundaryTs };
  }
  const boundaryTs = Math.max(0, Number(lastTimestamp) - CURSOR_OVERLAP_SECONDS);
  return { initial: false, boundaryTs, persistFromTs: 0 };
}

/** Advance a category cursor to (newest seen - overlap); never move backwards. */
export function advanceCursor(maxSeen: number | null, previous: bigint | null): bigint | null {
  if (maxSeen === null || maxSeen <= 0) return previous;
  const overlapped = Math.max(0, maxSeen - CURSOR_OVERLAP_SECONDS);
  if (previous !== null && BigInt(overlapped) < previous) return previous;
  return BigInt(overlapped);
}

/**
 * Incremental + historical log sync, CATEGORY-AWARE.
 *
 * Torn's /user/log returns the NEWEST page first and exposes older pages
 * only through `links.prev` — the old forward-only pagination silently
 * truncated every category to its first page. Each (user, resource,
 * category) now owns its cursor in SyncCategoryState:
 * - no category state yet + no resource cursor: initial backfill — walk the
 *   configured window, persist only rows inside it
 * - no category state + resource cursor present (migration bridge): seed the
 *   category from the resource watermark — the resource-level backfill
 *   already covered the window, so no deep re-walk is needed
 * - category state present: incremental — walk down to the category's own
 *   cursor (plus the overlap window); most categories need one page
 *
 * A failing category is recorded in its own state and DOES NOT stop the
 * others; the resource-level result aggregates pages, records and the worst
 * stop reason for the existing SyncState UI.
 */
async function syncLogsByCategories(args: SyncHandlerArgs, resource: SyncResource, categoryIds: Array<{ id: number; title: string }>): Promise<SyncHandlerResult> {
  const ctx = getWorkerContext();
  const [itemNameById, itemTypeById, itemMarketPriceById, itemIdByName] = await Promise.all([
    loadItemNameMap(ctx.db),
    loadItemTypeMap(ctx.db),
    loadMarketPrices(ctx.db),
    loadItemIdByName(ctx.db),
  ]);

  const nowSec = Math.floor(Date.now() / 1000);
  const resourceCursor = args.lastTimestamp;

  // Adaptive scheduling: load every category state once, decide due/skip.
  const allStates = await getSyncCategoryStates(ctx.db, args.userId, resource);
  const stateByCategory = new Map(allStates.map((st) => [st.categoryId, st]));

  interface DueCategory { category: { id: number; title: string }; state: (typeof allStates)[number] | null; priority: number }
  const dueCategories: DueCategory[] = [];
  let categoriesSkipped = 0;

  for (const category of categoryIds) {
    const state = stateByCategory.get(category.id) ?? null;
    if (!args.force && !isCategoryDue(state?.nextRunAt ?? null, nowSec)) {
      categoriesSkipped += 1;
      continue;
    }
    const schedule = nextCategorySchedule({
      lastNetNewRecords: null,
      lastActivityAt: state?.lastActivityAt ? Math.floor(state.lastActivityAt.getTime() / 1000) : null,
      consecutiveEmptyRuns: state?.consecutiveEmptyRuns ?? 0,
      status: state?.status ?? "active",
      now: nowSec,
    });
    dueCategories.push({ category, state, priority: schedule.priority });
  }
  dueCategories.sort((a, b) => a.priority - b.priority);

  let records = 0;
  let pagesWalked = 0;
  let maxTimestamp = resourceCursor !== null ? Number(resourceCursor) : 0;
  const stopReasons: BackwardStopReason[] = [];
  let sourceEarliest: number | null = null;
  let failedCategories = 0;
  const totalCategories = categoryIds.length;
  let categoriesProcessed = 0;

  for (const { category, state: existingState } of dueCategories) {
    // Rate budget: stop starting optional categories once this run reached
    // the page budget — they stay due and run next cycle. The global request
    // spacing / rate limiter is unaffected.
    if (pagesWalked >= SCHEDULE_THRESHOLDS.RUN_PAGE_BUDGET) {
      categoriesSkipped += 1;
      continue;
    }
    categoriesProcessed += 1;
    let state = existingState;
    if (state === null && resourceCursor !== null) {
      // Migration bridge: the resource-level backfill already stored this
      // category's window — seed from its watermark instead of re-walking.
      await upsertSyncCategoryState(ctx.db, args.userId, resource, category.id, {
        categoryTitle: category.title,
        status: "active",
        lastTimestamp: resourceCursor,
        lastSuccessAt: new Date(),
      });
      state = await getSyncCategoryState(ctx.db, args.userId, resource, category.id);
      logger.info({ userId: args.userId, resource, category: category.id }, "category cursor seeded from resource watermark");
    }

    const plan = planCategoryWalk(state?.lastTimestamp ?? null, ctx.initialHistoryDays, nowSec);
    let categoryRecords = 0;
    let maxSeen: number | null = null;

    try {
      const walk = await args.torn.iterateUserLogsBackward(
        { category: category.id, from: plan.boundaryTs, limit: 100 },
        async (logs, _metadata) => {
          logger.debug({ userId: args.userId, category: category.id, page: logs.length, stage: "page_received" }, "log page received");
          if (logs.length === 0) return;
          for (const log of logs) {
            if (log.timestamp > (maxSeen ?? 0)) maxSeen = log.timestamp;
            if (plan.initial && log.timestamp < plan.persistFromTs) continue;
            const normalized = normalizeLogEntry(log, { itemNameById, itemTypeById, itemMarketPriceById, itemIdByName });
            // Idempotent writes: a category's cursor only advances after its
            // page data is safely persisted (the upsert happens below, after
            // the whole walk succeeded).
            await insertTimelineEvents(ctx.db, args.userId, normalized.timelineEvents);
            await insertDrugEvents(ctx.db, args.userId, normalized.drugEvents);
            await insertConsumptionEvents(ctx.db, args.userId, normalized.consumptionEvents);
            await insertRehabEvents(ctx.db, args.userId, normalized.rehabEvents);
            await insertTravelTransitions(ctx.db, args.userId, normalized.travelTransitions);
            await insertTravelItemEvents(ctx.db, args.userId, normalized.travelItemEvents);
            await insertMoneyEvents(ctx.db, args.userId, normalized.moneyEvents);
            await insertCrimeEvents(ctx.db, args.userId, normalized.crimeEvents);
            categoryRecords += 1;
            if (log.timestamp > maxTimestamp) maxTimestamp = log.timestamp;
          }
          args.onProgress?.(records + categoryRecords);
        },
        { maxPages: 400, boundaryTs: plan.boundaryTs }
      );

      pagesWalked += walk.pages;
      stopReasons.push(walk.stopReason);
      if (walk.oldestTimestamp !== null && (sourceEarliest === null || walk.oldestTimestamp < sourceEarliest)) {
        sourceEarliest = walk.oldestTimestamp;
      }
      records += categoryRecords;
      // Activity: rows above the category's previous cursor are genuinely new.
      const previousCursor = state?.lastTimestamp ?? null;
      const netNew = maxSeen !== null && (previousCursor === null || maxSeen > Number(previousCursor));
      const consecutiveEmptyRuns = netNew ? 0 : (state?.consecutiveEmptyRuns ?? 0) + 1;
      const lastActivityAt = netNew ? new Date() : state?.lastActivityAt ?? null;
      const schedule = nextCategorySchedule({
        lastNetNewRecords: netNew ? categoryRecords : 0,
        lastActivityAt: lastActivityAt ? Math.floor(lastActivityAt.getTime() / 1000) : null,
        consecutiveEmptyRuns,
        status: "active",
        now: nowSec,
      });
      await upsertSyncCategoryState(ctx.db, args.userId, resource, category.id, {
        categoryTitle: category.title,
        status: walk.stopReason === "source_exhausted" ? "source_exhausted" : "active",
        lastTimestamp: advanceCursor(maxSeen, previousCursor),
        lastSuccessAt: new Date(),
        lastWalkPages: walk.pages,
        lastRecordsInserted: categoryRecords,
        sourceEarliestAt: walk.oldestTimestamp !== null ? BigInt(walk.oldestTimestamp) : null,
        errorMessage: null,
        nextRunAt: new Date(schedule.nextRunAt * 1000),
        frequencySeconds: schedule.nextFrequencySeconds,
        lastActivityAt,
        consecutiveEmptyRuns,
      });
      logger.info(
        { userId: args.userId, resource, category: category.id, title: category.title, pages: walk.pages, inserted: categoryRecords, stopReason: walk.stopReason, initial: plan.initial },
        "category walk complete"
      );
    } catch (err) {
      // One failed category must not prevent the others from completing —
      // record it in its own state and move on.
      const denied = err instanceof TornApiError && err.kind === "access_denied";
      failedCategories += 1;
      const consecutiveEmptyRuns = (state?.consecutiveEmptyRuns ?? 0) + 1;
      const retrySchedule = nextCategorySchedule({
        lastNetNewRecords: 0,
        lastActivityAt: state?.lastActivityAt ? Math.floor(state.lastActivityAt.getTime() / 1000) : null,
        consecutiveEmptyRuns,
        status: denied ? "access_denied" : "failed",
        now: nowSec,
      });
      await upsertSyncCategoryState(ctx.db, args.userId, resource, category.id, {
        categoryTitle: category.title,
        status: denied ? "access_denied" : "failed",
        errorMessage: (err as Error).message.slice(0, 300),
        nextRunAt: new Date(retrySchedule.nextRunAt * 1000),
        frequencySeconds: retrySchedule.nextFrequencySeconds,
        consecutiveEmptyRuns,
      });
      logger.warn({ userId: args.userId, resource, category: category.id, err: (err as Error).message }, "category walk failed; continuing");
    }
  }

  // Trips are assembled from transitions, never written per log — rebuild
  // them after a travel-domain fetch so new flights close out. Other log
  // resources never produce flight transitions; re-assembling there would
  // reload every transition + purchase for nothing.
  if (categoryIds.length > 0 && (resource === "travel" || resource === "rehab")) {
    const assembly = await assembleTripsFromTransitions(ctx.db, args.userId);
    if (assembly.trips > 0) {
      logger.debug({ userId: args.userId, trips: assembly.trips, unmatched: assembly.unmatchedTransitions }, "travel trips assembled");
    }
  }

  const walkStopReason = aggregateStopReason(stopReasons);
  return {
    records,
    pagesWalked,
    lastTimestamp: maxTimestamp > 0 ? BigInt(maxTimestamp) : null,
    stopReason: failedCategories > 0 ? "api_error" : walkStopReason,
    sourceEarliestAt: sourceEarliest !== null ? BigInt(sourceEarliest) : null,
    failedCategories,
    totalCategories,
    categoriesDue: dueCategories.length,
    categoriesProcessed,
    categoriesSkipped,
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
export const syncDrugLogs: SyncHandler = async (args) => syncLogsByCategories(args, "drugs", await resolveCategoryIds(args.userId, ["drug", "item use"]));

// Torn has NO rehab log category: rehab visits are filed under the "Travel"
// category with the title "Rehab". The keyword list therefore mirrors the
// travel resource; the normalizer routes by title.
export const syncRehabLogs: SyncHandler = async (args) =>
  syncLogsByCategories(args, "rehab", await resolveCategoryIds(args.userId, ["travel", "abroad", "fly", "flight", "rehab", "rehabilitation"]));

export const syncTravelLogs: SyncHandler = async (args) =>
  syncLogsByCategories(args, "travel", await resolveCategoryIds(args.userId, ["travel", "abroad", "fly", "flight"]));

// Financial surface. Beyond the obvious money keywords this includes the real
// category names observed in a live 180-day history: "Company", "Job",
// "Property", "Shops", "Item market", "Donator", "Offshore bank", "Piggy
// bank", "Loan", "Gym". The normalizer decides which entries are actual
// movements.
export const syncMoneyLogs: SyncHandler = async (args) =>
  syncLogsByCategories(args, "money_logs", await resolveCategoryIds(args.userId, [
    "trade", "money", "bazaar", "bank", "casino", "stock", "salary", "points", "auction", "crime", "mug", "payout",
    "company", "job", "property", "shop", "item market", "donator", "offshore", "piggy", "loan", "upkeep", "faction", "attacking",
    "gym",
  ]));

/* -------------------------------------------------------------------------- */
/* events (Torn events -> timeline)                                           */
/* -------------------------------------------------------------------------- */



/** Normalized combat event (pre-persistence). */
export interface NormalizedAttack {
  occurredAt: Date;
  attackId: number;
  direction: "incoming" | "outgoing";
  opponentId: number | null;
  opponentName: string | null;
  result: string;
  respectDelta: number | null;
  modifiers: Record<string, unknown> | null;
  raw: unknown;
}

/**
 * Pure attack payload -> combat event projection. Direction comes from the
 * payload side naming the account; the opponent may be unknown (Torn nulls
 * some attacker profiles) and is never fabricated. Respect is the net
 * gain-loss swing; raw both-direction values stay in metadata.
 */
export function normalizeAttack(a: { id: number; started: number; ended?: number; attacker?: { id?: number; name?: string } | null; defender?: { id?: number; name?: string } | null; result: string; respect_gain?: number | null; respect_loss?: number | null; modifiers?: Record<string, unknown> | null }, myId: number): NormalizedAttack {
  const attackerId = typeof a.attacker?.id === "number" ? a.attacker.id : null;
  const defenderId = typeof a.defender?.id === "number" ? a.defender.id : null;
  const incoming = defenderId === myId;
  const opponent = (incoming ? a.attacker : a.defender) ?? null;
  const opponentId = typeof opponent?.id === "number" ? opponent.id : null;
  const opponentName = typeof opponent?.name === "string" ? opponent.name : null;
  const respectDelta =
    a.respect_gain !== null && a.respect_gain !== undefined ? (a.respect_gain ?? 0) - (a.respect_loss ?? 0) : a.respect_loss !== null && a.respect_loss !== undefined ? -(a.respect_loss ?? 0) : null;
  return {
    occurredAt: new Date((a.ended || a.started) * 1000),
    attackId: a.id,
    direction: incoming ? "incoming" : "outgoing",
    opponentId,
    opponentName,
    result: a.result,
    respectDelta,
    modifiers: (a.modifiers ?? null) as Record<string, unknown> | null,
    raw: a,
  };
};

/**
 * Combat sync from /v2/user/attacks (backward pagination, own resource
 * cursor). Direction: the payload side naming the account decides
 * outgoing/incoming; opponents Torn nulls render as "Unknown opponent".
 * Mug cash is NOT written here — it flows through the mug logs into
 * MoneyEvent (category mugging), keeping one canonical ledger row.
 */
export const syncAttacks: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const account = await ctx.db.tornAccount.findUnique({ where: { userId: args.userId }, select: { tornId: true } });
  if (!account) {
    logger.info({ userId: args.userId }, "attacks sync skipped: no torn account yet");
    return { records: 0, pagesWalked: 0 };
  }
  const myId = account.tornId;
  const boundaryTs = historyBoundaryTs(args.lastTimestamp, ctx.initialHistoryDays);

  let records = 0;
  let maxSeen: number | null = null;

  const walk = await args.torn.iterateUserAttacksBackward(
    { from: boundaryTs, limit: 100 },
    async (attacks) => {
      if (attacks.length === 0) return;
      const inputs = attacks.map((a) => normalizeAttack(a, myId));
      await insertCombatEvents(ctx.db, args.userId, inputs);
      records += attacks.length;
      for (const a of attacks) {
        const ts = a.ended || a.started;
        if (ts > (maxSeen ?? 0)) maxSeen = ts;
      }
      args.onProgress?.(records);
    },
    { maxPages: 200, boundaryTs }
  );
  logger.info({ userId: args.userId, pages: walk.pages, stopReason: walk.stopReason, oldest: walk.oldestTimestamp }, "attacks backward walk finished");

  return {
    records,
    pagesWalked: walk.pages,
    lastTimestamp: maxSeen !== null ? BigInt(maxSeen) : args.lastTimestamp,
    stopReason: walk.stopReason,
    sourceEarliestAt: walk.oldestTimestamp !== null ? BigInt(walk.oldestTimestamp) : null,
  };
};

export const syncEvents: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const boundaryTs = historyBoundaryTs(args.lastTimestamp, ctx.initialHistoryDays);
  const enforceBoundary = args.lastTimestamp === null;

  let records = 0;
  let maxTimestamp = args.lastTimestamp !== null ? Number(args.lastTimestamp) : 0;

  const walk = await args.torn.iterateUserEventsBackward(
    { from: boundaryTs, limit: 100 },
    async (events) => {
      if (events.length === 0) return;
      const inWindow = enforceBoundary ? events.filter((e) => e.timestamp >= boundaryTs) : events;
      if (inWindow.length === 0) return;
      await insertTimelineEvents(ctx.db, args.userId, inWindow.map((event) => normalizeTornEvent(event)));
      records += inWindow.length;
      for (const event of inWindow) {
        if (event.timestamp > maxTimestamp) maxTimestamp = event.timestamp;
      }
      args.onProgress?.(records);
    },
    { maxPages: 200, boundaryTs }
  );
  logger.debug({ userId: args.userId, pages: walk.pages, stopReason: walk.stopReason, oldest: walk.oldestTimestamp }, "events backward walk finished");

  return {
    records,
    pagesWalked: walk.pages,
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
/* Faction sync (basic/members/balance, ranked wars, chains, OC)               */
/* -------------------------------------------------------------------------- */

/**
 * Faction profile + members + bank balance snapshot. Members are recorded as
 * FactionMembership rows keyed by faction-member id, so historical members
 * keep their identity when they leave the current roster.
 */
export const syncFaction: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const caps = args.capabilities ?? null;
  const [basicFull, members, balance] = await Promise.all([
    args.torn.factionBasicFull(),
    // Skip sub-fetches the key cannot answer — never hammer denied endpoints.
    caps && !caps.canReadFactionMembers ? Promise.resolve(null) : args.torn.factionMembers().catch(() => null),
    caps && !caps.canReadFactionBalance ? Promise.resolve(null) : args.torn.factionBalance().catch(() => null),
  ]);
  const f = basicFull.basic;
  if (typeof f.id !== "number") return { records: 0 };

  await upsertFaction(ctx.db, {
    id: f.id,
    name: String(f.name ?? ""),
    tag: f.tag !== null && f.tag !== undefined ? String(f.tag) : null,
    leaderId: typeof f.leader_id === "number" ? f.leader_id : null,
    coLeaderId: typeof f.co_leader_id === "number" ? f.co_leader_id : null,
    respect: typeof f.respect === "number" ? f.respect : null,
    daysOld: typeof f.days_old === "number" ? f.days_old : null,
    capacity: typeof f.capacity === "number" ? f.capacity : null,
    members: typeof f.members === "number" ? f.members : null,
    bestChain: typeof f.best_chain === "number" ? f.best_chain : null,
  });
  await insertFactionSnapshot(ctx.db, args.userId, f.id, new Date(), typeof f.members === "number" ? f.members : null, typeof f.respect === "number" ? f.respect : null, f);

  let memberRows = 0;
  if (members) {
    // Roster with real identity (Torn id, name, position, level, days in
    // faction, last action) — names persist for members who later leave.
    memberRows = await upsertFactionMemberRoster(
      ctx.db,
      args.userId,
      f.id,
      members.map((m) => ({
        memberId: m.id,
        name: m.name ?? null,
        position: m.position ?? null,
        level: m.level ?? null,
        daysInFaction: m.days_in_faction ?? null,
        lastActionAt: m.last_action?.until !== null && m.last_action?.until !== undefined ? new Date(m.last_action.until * 1000) : null,
        lastActionStatus: m.last_action?.status ?? m.status ?? null,
      }))
    );
  }

  let balanceRows = 0;
  if (balance?.balance) {
    const input = {
      factionId: f.id,
      money: balance.balance.faction?.money !== null && balance.balance.faction?.money !== undefined ? BigInt(balance.balance.faction.money) : null,
      points: balance.balance.faction?.points ?? null,
      scope: balance.balance.faction?.scope ?? null,
      members: (balance.balance.members ?? []) as unknown as never,
      capturedAt: new Date(),
    };
    await upsertFactionBalanceSnapshot(ctx.db, args.userId, input);
    balanceRows = 1;
  }

  // Armory news walk (cat=armoryAction): first-class provenance for
  // faction-sponsored consumption (e.g. armory Xanax). Incremental: walks
  // backward until a page whose entries are all already stored. Skipped
  // entirely (not "failed") when the key lacks armorynews access.
  let armoryEvents = 0;
  if (caps && !caps.canReadFactionArmoryNews) {
    logger.debug({ userId: args.userId }, "faction armory news skipped: key lacks armorynews access");
  } else {
    try {
      armoryEvents = await walkFactionArmoryNews(args, ctx.db, f.id);
    } catch (err) {
      logger.warn({ err: (err as Error).message, userId: args.userId }, "faction armory news walk failed; continuing");
    }
  }

  return { records: 1 + memberRows + balanceRows + armoryEvents, stopReason: "history_boundary_reached" };
}

/**
 * Walk /faction/news?cat=armoryAction backward (from/to windows), parse each
 * entry and store FactionArmoryEvent rows. Idempotent by news id; stops when
 * a page adds nothing new (already stored), when the feed ends, or after
 * `maxPages`. Rate limiting is handled by the API client.
 */
export async function walkFactionArmoryNews(
  args: { userId: string; torn: TornEndpoints },
  db: ReturnType<typeof getWorkerContext>["db"],
  factionId: number,
  opts: { maxPages?: number } = {}
): Promise<number> {
  const maxPages = opts.maxPages ?? 60;
  const [itemIdByName, marketPrices] = await Promise.all([loadItemIdByName(db), loadMarketPrices(db)]);
  let to: number | null = Math.floor(Date.now() / 1000);
  let stored = 0;
  let oldest: number | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params: TornRequestParams = {};
    if (to !== null) params.to = to;
    const { news } = await args.torn.factionArmoryNewsPage(params);
    if (news.length === 0) break;
    let newOnPage = 0;
    let pageOldest = Infinity;
    const inputs: FactionArmoryEventInput[] = [];
    for (const n of news) {
      pageOldest = Math.min(pageOldest, n.timestamp);
      const parsed = parseArmoryNews(n.text);
      if (!parsed) continue;
      const itemId = itemIdByName.get(parsed.itemName) ?? itemIdByName.get(parsed.itemName.toLowerCase()) ?? null;
      const unitPrice = itemId !== null ? marketPrices.get(itemId) : undefined;
      inputs.push({
        factionId,
        memberId: parsed.memberId,
        memberName: parsed.memberName,
        itemId,
        itemName: parsed.itemName,
        action: parsed.action,
        quantity: parsed.quantity,
        value: unitPrice !== undefined ? BigInt(Math.round(Number(unitPrice)) * parsed.quantity) : null,
        sourceRef: n.id,
        occurredAt: new Date(n.timestamp * 1000),
        raw: { text: n.text },
      });
    }
    // The upsert returns how many rows were GENUINELY new. Parsing again on
    // an already-stored page must not count as progress — otherwise this walk
    // would never early-stop and would burn Torn quota every hour forever.
    newOnPage = await upsertFactionArmoryEvents(db, args.userId, inputs);
    stored += newOnPage;
    oldest = pageOldest === Infinity ? oldest : pageOldest;
    // Older-than-everything page: every parsed entry was already stored.
    if (newOnPage === 0) break;
    if (pageOldest === Infinity) break;
    to = pageOldest - 1;
  }
  return stored;
};

/**
 * Ranked war history: upsert every war keyed by Torn war id. Completed wars
 * are permanent — Torn pruning the history endpoint never removes them.
 */
export const syncRankedWars: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const factionId = await resolveUserFactionId(ctx.db, args.userId);
  if (factionId === null) return { records: 0 };
  let wars = 0;
  await args.torn.iterateFactionRankedWars(async (page) => {
    for (const w of page) {
      const ours = w.factions.find((f) => f.id === factionId) ?? null;
      const opp = w.factions.find((f) => f.id !== factionId) ?? null;
      await upsertRankedWar(ctx.db, {
        tornWarId: w.id,
        factionId,
        opponentFactionId: opp?.id ?? null,
        opponentName: opp?.name ?? null,
        startedAt: new Date(w.start * 1000),
        endedAt: w.end ? new Date(w.end * 1000) : null,
        winnerFactionId: w.winner ?? null,
        targetScore: w.target ?? null,
        ourScore: ours?.score ?? null,
        opponentScore: opp?.score ?? null,
        ourChain: ours?.chain ?? null,
        opponentChain: opp?.chain ?? null,
        raw: w as object,
      });
      wars += 1;
    }
  }, { maxPages: 20 });
  logger.info({ userId: args.userId, wars }, "ranked wars synced");
  return { records: wars, stopReason: "history_boundary_reached" };
};

export async function resolveUserFactionId(db: ReturnType<typeof getWorkerContext>["db"], userId: string): Promise<number | null> {
  const account = await db.tornAccount.findUnique({ where: { userId }, select: { factionId: true } });
  return account?.factionId ?? null;
}

/** Historical faction chains. */
export const syncChains: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const factionId = await resolveUserFactionId(ctx.db, args.userId);
  if (factionId === null) return { records: 0 };
  let chains = 0;
  await args.torn.iterateFactionChains(async (page) => {
    for (const c of page) {
      await upsertFactionChain(ctx.db, args.userId, {
        factionId,
        chainId: c.id,
        chain: c.chain,
        respect: c.respect ?? null,
        startedAt: new Date(c.start * 1000),
        endedAt: new Date(c.end * 1000),
      });
      chains += 1;
    }
  }, { maxPages: 20 });
  logger.info({ userId: args.userId, chains }, "faction chains synced");
  return { records: chains, stopReason: "history_boundary_reached" };
};

/** Organized crimes (OC 2.0) with participants and rewards. */
export const syncOrganizedCrimes: SyncHandler = async (args) => {
  const ctx = getWorkerContext();
  const factionId = await resolveUserFactionId(ctx.db, args.userId);
  if (factionId === null) return { records: 0 };
  let crimes = 0;
  await args.torn.iterateFactionOrganizedCrimes(async (page) => {
    for (const c of page) {
      await upsertOrganizedCrime(ctx.db, args.userId, {
        factionId,
        ocId: c.id,
        name: c.name,
        difficulty: c.difficulty ?? null,
        status: c.status,
        createdAt: c.created_at ? new Date(c.created_at * 1000) : null,
        planningAt: c.planning_at ? new Date(c.planning_at * 1000) : null,
        executedAt: c.executed_at ? new Date(c.executed_at * 1000) : null,
        readyAt: c.ready_at ? new Date(c.ready_at * 1000) : null,
        expiredAt: c.expired_at ? new Date(c.expired_at * 1000) : null,
        rewards: (c.rewards ?? null) as never,
        slots: (c.slots ?? null) as never,
      });
      crimes += 1;
    }
  }, { maxPages: 20 });
  logger.info({ userId: args.userId, crimes }, "organized crimes synced");
  return { records: crimes, stopReason: "history_boundary_reached" };
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export const SYNC_HANDLERS: Record<SyncResource, SyncHandler> = {
  profile: syncProfile,
  bars: syncBars,
  personal_stats: syncPersonalStats,
  networth: syncNetworth,
  drugs: syncDrugLogs,
  travel: syncTravelLogs,
  rehab: syncRehabLogs,
  money_logs: syncMoneyLogs,
  events: syncEvents,
  attacks: syncAttacks,
  faction: syncFaction,
  ranked_wars: syncRankedWars,
  chains: syncChains,
  organized_crimes: syncOrganizedCrimes,
  faction_basic: syncFactionBasic,
  torn_catalog: syncTornCatalog,
};
