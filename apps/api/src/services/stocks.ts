import { assembleStockRow, type StockCatalogEntry, type StockIntelligenceRow, type UserBonusState } from "@tornscope/analytics";
import type { StocksResponse, StockSummaryDto, FeatureAvailability as FeatureAvailabilityDto } from "@tornscope/shared";
import { getApiContext } from "../context.js";
import { liveAvailability, loadAvailabilityContext, type AvailabilityContext } from "./availability.js";

/**
 * Stocks service (live-requested, Today-service precedent).
 *
 * SOURCE AUDIT (Torn API v2, spec 6.13.5, verified live):
 * - `/v2/user/stocks` → owned stocks: exact shares + per-user bonus state
 *   ({available, increment, progress, frequency}). Minimal access.
 * - `/v2/torn/stocks` (public) → all 35 stocks: exact market price at
 *   capture + the benefit definition (requirement, frequency, description,
 *   passive flag). ONE benefit block per stock — the bonus is an object,
 *   not an array, in the spec itself.
 * - Reward valuation reuses the SAME TornItemCatalog the Drugs/Travel
 *   pages use; rewards that do not resolve there render as unvalued, never
 *   as a fabricated $0.
 *
 * No schema: holdings are current-state data with no historical product
 * need (see docs/STOCKS.md). The catalog is cached in-process for a day;
 * holdings are fetched per view with a short single-flight cache.
 */

const HOLDINGS_CACHE_TTL_MS = 60_000;
const CATALOG_TTL_MS = 24 * 60 * 60_000;

interface CacheEntry {
  expiresAt: number;
  promise: Promise<StocksResponse>;
}
const cache = new Map<string, CacheEntry>();

let catalogCache: { fetchedAt: number; promise: Promise<Map<number, StockCatalogEntry>> } | null = null;

/** Test seam: drop in-process caches. */
export function clearStocksCaches(): void {
  cache.clear();
  catalogCache = null;
}

export function getStocks(user: { id: string; isDemo: boolean }): Promise<StocksResponse> {
  if (user.isDemo) return Promise.resolve(buildDemoStocks());
  const now = Date.now();
  const entry = cache.get(user.id);
  if (entry && entry.expiresAt > now) return entry.promise;
  const promise = fetchStocks(user.id);
  cache.set(user.id, { expiresAt: now + HOLDINGS_CACHE_TTL_MS, promise });
  return promise;
}

async function fetchStocks(userId: string): Promise<StocksResponse> {
  const ctx = getApiContext();
  const availabilityCtx = await loadAvailabilityContext(userId);
  const availability = availabilityOf(availabilityCtx);

  if (availabilityCtx.caps && !availabilityCtx.caps.canReadUserStocks) {
    return emptyResponse(availability);
  }

  const credential = await ctx.db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) return emptyResponse(availability);

  const torn = ctx.torn(ctx.decryptCredential(credential));
  const priceCapturedAt = Math.floor(Date.now() / 1000);
  const [rawHoldings, catalog] = await Promise.all([
    torn.userStocks(),
    loadCatalog(torn),
  ]);

  const holdingsById = new Map(rawHoldings.stocks.map((s) => [s.id, s]));
  // One batched lookup for every reward item — never per-row queries.
  const itemNames = new Set(
    [...catalog.values()]
      .filter((c) => c.benefit && /^\d+x /i.test(c.benefit.description) && !/^random property$/i.test(c.benefit.description.replace(/^\d+x /i, "").trim()))
      .map((c) => c.benefit!.description.replace(/^\d+x /i, "").trim().toLowerCase())
  );
  const itemPriceByName = await loadItemPrices(ctx, itemNames);

  const rows = [...catalog.values()]
    .sort((a, b) => a.acronym.localeCompare(b.acronym))
    .map((entry) =>
      assembleStockRow({
        catalog: entry,
        shares: holdingsById.get(entry.id)?.shares ?? null,
        bonus: holdingsById.get(entry.id)?.bonus ?? null,
        priceCapturedAt,
        itemPriceByName,
      })
    );

  return {
    summary: summarize(rows),
    rows,
    availability: { ...availability, state: "available_live", lastRefreshedAt: Math.floor(Date.now() / 1000) },
    priceCapturedAt,
    unvaluedItemNames: [...itemNames].filter((n) => !itemPriceByName.has(n)),
  };
}

async function loadCatalog(torn: ReturnType<ReturnType<typeof getApiContext>["torn"]>): Promise<Map<number, StockCatalogEntry>> {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) return catalogCache.promise;
  const promise = torn.tornStocks().then((stocks) => {
    const map = new Map<number, StockCatalogEntry>();
    for (const s of stocks) {
      map.set(s.id, {
        id: s.id,
        name: s.name,
        acronym: s.acronym,
        price: s.market?.price ?? null,
        benefit: s.bonus
          ? {
              passive: s.bonus.passive,
              frequency: s.bonus.frequency,
              requirement: s.bonus.requirement,
              description: s.bonus.description,
            }
          : null,
      });
    }
    return map;
  });
  catalogCache = { fetchedAt: Date.now(), promise };
  try {
    return await promise;
  } catch {
    catalogCache = null;
    return new Map();
  }
}

async function loadItemPrices(ctx: ReturnType<typeof getApiContext>, names: Set<string>): Promise<Map<string, number>> {
  if (names.size === 0) return new Map();
  const items = await ctx.db.tornItemCatalog.findMany({
    // Case-insensitive: descriptions say "1x Six-Pack of Energy Drink" and
    // the catalog stores exactly that casing — key the result lowercase.
    where: { name: { in: [...names], mode: "insensitive" } },
    select: { name: true, marketPrice: true },
  });
  return new Map(
    items
      .map((i) => [i.name.toLowerCase(), Number(i.marketPrice ?? 0)] as const)
      .filter(([, p]) => p > 0)
  );
}

function summarize(rows: StockIntelligenceRow[]): StockSummaryDto {
  let portfolioValue = 0;
  let hasValue = false;
  let stocksOwned = 0;
  let activeBenefits = 0;
  let annual = 0;
  let hasAnnual = false;
  let unvalued = 0;
  for (const row of rows) {
    if (!row.owned) continue;
    stocksOwned += 1;
    if (row.positionValue !== null) {
      portfolioValue += row.positionValue;
      hasValue = true;
    }
    if (row.benefitReached) {
      activeBenefits += 1;
      if (row.reward && row.reward.valuePerPayout === null) unvalued += 1;
      if (row.estimatedAnnualValue !== null) {
        annual += row.estimatedAnnualValue;
        hasAnnual = true;
      }
    }
  }
  return {
    portfolioValue: hasValue ? portfolioValue : null,
    stocksOwned,
    activeBenefits,
    estimatedAnnualBenefit: hasAnnual ? annual : null,
    unvaluedBenefitCount: unvalued,
  };
}

function availabilityOf(ctx: AvailabilityContext): FeatureAvailabilityDto {
  return liveAvailability(ctx, "stocks_holdings");
}

function emptyResponse(availability: FeatureAvailabilityDto): StocksResponse {
  return {
    summary: { portfolioValue: null, stocksOwned: 0, activeBenefits: 0, estimatedAnnualBenefit: null, unvaluedBenefitCount: 0 },
    rows: [],
    availability,
    priceCapturedAt: null,
    unvaluedItemNames: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Demo dataset                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic synthetic demo portfolio — pushed through the SAME
 * assembly as real data. Covers every reward class and holding state:
 * an active cash benefit, an active item benefit (catalog-priced), a
 * below-threshold position, an unowned stock, a passive perk, points,
 * and an unvalued item.
 */
function buildDemoStocks(): StocksResponse {
  const catalog = new Map<number, StockCatalogEntry>(DEMO_CATALOG.map((c) => [c.id, c]));
  const holdings = new Map(DEMO_HOLDINGS.map((h) => [h.id, h]));
  const itemPriceByName = new Map<string, number>([
    ["drug pack", 4_301_565],
    ["box of grenades", 1_078_277],
    ["six-pack of energy drink", 16_474_180],
    ["feathery hotel coupon", 14_202_744],
  ]);
  const priceCapturedAt = Math.floor(Date.now() / 1000);
  const rows = [...catalog.values()]
    .sort((a, b) => a.acronym.localeCompare(b.acronym))
    .map((entry) =>
      assembleStockRow({
        catalog: entry,
        shares: holdings.get(entry.id)?.shares ?? null,
        bonus: holdings.get(entry.id)?.bonus ?? null,
        priceCapturedAt,
        itemPriceByName,
      })
    );
  return {
    summary: summarize(rows),
    rows,
    availability: {
      state: "available_historical",
      requiresLabel: null,
      requiresSelections: [],
      hasHistoricalData: true,
      lastRefreshedAt: priceCapturedAt,
    },
    priceCapturedAt,
    unvaluedItemNames: ["ammunition pack"],
  };
}

interface DemoHolding {
  id: number;
  shares: number;
  bonus: UserBonusState;
}

/** TCB/TCI-style demo holdings over the demo catalog below. */
const DEMO_HOLDINGS: DemoHolding[] = [
  // IIL-like: active item benefit, mid-cycle (derived timing).
  { id: 101, shares: 1_000_000, bonus: { available: false, increment: 1, progress: 3, frequency: 7 } },
  // TCP-like: ready to collect now.
  { id: 102, shares: 1_000_000, bonus: { available: true, increment: 1, progress: 7, frequency: 7 } },
  // TCT-like: active cash benefit, mid-cycle.
  { id: 103, shares: 100_000, bonus: { available: false, increment: 1, progress: 12, frequency: 31 } },
  // FHG-like: below threshold — no active benefit yet.
  { id: 104, shares: 500_000, bonus: { available: false, increment: 1, progress: 0, frequency: 7 } },
];

const DEMO_CATALOG: StockCatalogEntry[] = [
  { id: 101, name: "Iil Intrastructural Ltd.", acronym: "IIL", price: 655.4, benefit: { passive: false, frequency: 7, requirement: 1_000_000, description: "50% coding time reduction" } },
  { id: 102, name: "Torn City Petroleum", acronym: "TCP", price: 812.25, benefit: { passive: true, frequency: 7, requirement: 1_000_000, description: "a Company sales boost" } },
  { id: 103, name: "Torn City Holdings", acronym: "TCT", price: 998.75, benefit: { passive: false, frequency: 31, requirement: 100_000, description: "$1,000,000" } },
  { id: 104, name: "Feathery Hotels Group", acronym: "FHG", price: 445.1, benefit: { passive: false, frequency: 7, requirement: 2_000_000, description: "1x Feathery Hotel Coupon" } },
  { id: 105, name: "Symbiotic Ltd.", acronym: "SYM", price: 745.32, benefit: { passive: false, frequency: 7, requirement: 500_000, description: "1x Drug Pack" } },
  { id: 106, name: "EWM Weapons Co.", acronym: "EWM", price: 1_105.0, benefit: { passive: false, frequency: 7, requirement: 1_000_000, description: "1x Box of Grenades" } },
  { id: 107, name: "Munitionnement SARL", acronym: "MUN", price: 522.6, benefit: { passive: false, frequency: 7, requirement: 5_000_000, description: "1x Six-Pack of Energy Drink" } },
  { id: 108, name: "Bagnatore & Figli", acronym: "BAG", price: 690.45, benefit: { passive: false, frequency: 7, requirement: 3_000_000, description: "1x Ammunition Pack" } },
  { id: 109, name: "Torn & Shanghai Banking", acronym: "TSB", price: 1_172.26, benefit: { passive: false, frequency: 31, requirement: 3_000_000, description: "$50,000,000" } },
  { id: 110, name: "Points Trade Corp.", acronym: "PTS", price: 890.15, benefit: { passive: false, frequency: 7, requirement: 10_000_000, description: "100 points" } },
  { id: 111, name: "Torn City Insurance", acronym: "TCI", price: 533.8, benefit: { passive: true, frequency: 7, requirement: 1_500_000, description: "a 10% bank interest bonus" } },
];
