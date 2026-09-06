import {
  resolveDateRange,
  type DateRangeInput,
  type TravelSummaryResponse,
  type TravelTripDto,
  type Paginated,
  type Provenance,
} from "@tornscope/shared";
import { calculateTravelProfit, calculateTripEconomics, buildDailyTravelProfit } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";

/** Travel analytics: pre-assembled trips + their linked abroad purchases. */
export async function getTravelSummary(userId: string, rangeInput: DateRangeInput): Promise<TravelSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);

  const [marketPrices, earliestTransition, earliestCompleteTrip, travelSyncState] = await Promise.all([
    loadMarketPrices(db),
    db.travelTransition.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.travelEvent.findFirst({ where: { userId, source: "trip", returnedAt: { not: null } }, orderBy: { departedAt: "asc" }, select: { departedAt: true } }),
    db.syncState.findUnique({ where: { userId_resource: { userId, resource: "travel" } }, select: { sourceEarliestAt: true } }),
  ]);
  const { trips, unattached } = await loadTrips(userId, range.from, range.to, marketPrices);

  const summary = calculateTravelProfit(trips, range.from, range.to);

  const topDest = summary.byDestination[0] ?? null;
  const topItem = findTopItem(trips, marketPrices);

  const profitAvailable = summary.trips > 0;
  return {
    range: { from: range.from, to: range.to },
    trips: summary.trips,
    coverage: {
      // Permanently stored evidence: trips never disappear when Torn prunes.
      trackingSince: earliestTransition ? Math.floor(earliestTransition.occurredAt.getTime() / 1000) : null,
      // Earliest trip with BOTH departure and return stored.
      completeTripsFrom: earliestCompleteTrip ? Math.floor(earliestCompleteTrip.departedAt.getTime() / 1000) : null,
      // Oldest travel log observed by the deepest backward walk so far.
      sourceAvailableFrom: travelSyncState?.sourceEarliestAt !== null && travelSyncState?.sourceEarliestAt !== undefined ? Number(travelSyncState.sourceEarliestAt) : null,
    },
    estimatedProfit: {
      value: profitAvailable ? summary.estimatedProfit : null,
      provenance: "estimated",
      availability: profitAvailable ? "ok" : unattached.count > 0 ? "incomplete" : "unavailable",
    },
    averageTripProfit: {
      value: profitAvailable ? summary.averageProfitPerTrip : null,
      provenance: "estimated",
      availability: profitAvailable ? "ok" : "unavailable",
    },
    profitPerHour: {
      value: profitAvailable ? summary.averageProfitPerHour : null,
      provenance: "estimated",
      availability: profitAvailable ? (summary.averageProfitPerHour === null ? "incomplete" : "ok") : "unavailable",
    },
    topDestination: { destination: topDest?.destination ?? null, profit: topDest?.estimatedProfit ?? null },
    topItem: topItem,
    profitSeries: buildProfitSeries(trips, range.from, range.to),
    profitByDestination: summary.byDestination.map((d) => ({
      destination: d.destination,
      trips: d.trips,
      profit: d.estimatedProfit ?? -d.totalSpend,
      provenance: (d.estimatedProfit !== null ? "estimated" : "derived") as Provenance,
    })),
    itemsByCategory: summary.byCategory.map((c) => ({
      category: c.category,
      quantity: c.quantity,
      spend: c.spend,
      estimatedValue: c.estimatedValue,
    })),
    unattachedPurchases: unattached,
  };
}

export async function getTravelHistory(userId: string, rangeInput: DateRangeInput, limit: number, cursor?: string): Promise<Paginated<TravelTripDto>> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  // Trips are stored assembled (source="trip"); cursor pagination slices the
  // resulting DTOs by departure time.
  const marketPrices = await loadMarketPrices(db);
  const { trips } = await loadTrips(userId, range.from, range.to, marketPrices);

  const dtos: TravelTripDto[] = trips
    .sort((a, b) => b.departedAt - a.departedAt)
    .map((trip) => {
      const econ = calculateTripEconomics(trip);
      return {
        id: trip.id,
        departedAt: trip.departedAt,
        returnedAt: trip.returnedAt,
        destination: trip.destination,
        durationSeconds: econ.durationSeconds,
        itemsBought: trip.items.reduce((s, i) => s + i.quantity, 0),
        spend: econ.spend,
        estimatedRevenue: econ.estimatedRevenue,
        estimatedProfit: econ.estimatedProfit,
        profitPerHour: econ.profitPerHour,
        provenance: econ.provenance,
        items: trip.items.map((item) => {
          const estUnit = marketPrices.get(item.itemId);
          return {
            id: item.id,
            itemName: item.itemName ?? `Item ${item.itemId}`,
            category: String(item.category),
            quantity: item.quantity,
            unitCost: item.unitCost,
            totalCost: item.totalCost,
            estimatedUnitValue: estUnit !== undefined ? Number(estUnit) : null,
            estimatedProfit: estUnit !== undefined ? Number(estUnit) * item.quantity - item.totalCost : null,
          };
        }),
      };
    });

  // Cursor over the sorted array (departure timestamp + id keyset).
  let startIdx = 0;
  if (cursor) {
    try {
      const ts = Number(Buffer.from(cursor, "base64url").toString("utf8"));
      startIdx = dtos.findIndex((t) => t.departedAt <= ts);
      if (startIdx === -1) startIdx = dtos.length;
    } catch {
      startIdx = 0;
    }
  }
  const page = dtos.slice(startIdx, startIdx + limit);
  const lastPageItem = page[page.length - 1];
  const nextCursor = startIdx + limit < dtos.length && lastPageItem ? Buffer.from(String(lastPageItem.departedAt), "utf8").toString("base64url") : null;
  return { items: page, nextCursor };
}

/* -------------------------------------------------------------------------- */

interface LoadedTrip {
  id: string;
  destination: string;
  departedAt: number;
  returnedAt: number | null;
  durationSeconds: number | null;
  items: Array<{
    id: string;
    itemId: number;
    itemName: string | null;
    category: string;
    quantity: number;
    unitCost: number;
    totalCost: number;
    estimatedUnitValue: number | null;
  }>;
}

/**
 * Load assembled trips with their DB-linked purchases. Trips are built by the
 * worker/renormalize step from real travel transitions — this read path never
 * re-assembles or fabricates. Purchases whose trip is unknown (departure logs
 * beyond Torn's travel-log retention) are returned separately as unattached.
 */
async function loadTrips(userId: string, from: number, to: number, marketPrices: Map<number, bigint>) {
  const db = getPrismaClient();
  const windowFrom = new Date((from - 7 * 86_400) * 1000);
  const [tripRows, itemRows] = await Promise.all([
    db.travelEvent.findMany({
      where: { userId, departedAt: { gte: windowFrom, lte: new Date(to * 1000) } },
      orderBy: { departedAt: "asc" },
      select: { id: true, destination: true, departedAt: true, returnedAt: true, durationSeconds: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, occurredAt: { gte: windowFrom, lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { id: true, travelEventId: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true, occurredAt: true, destination: true },
    }),
  ]);

  const mapItem = (r: (typeof itemRows)[number]) => ({
    id: r.id,
    itemId: r.itemId,
    itemName: r.itemName,
    category: r.category,
    quantity: r.quantity,
    unitCost: bigintToNumber(r.unitCost) ?? 0,
    totalCost: bigintToNumber(r.totalCost) ?? 0,
    estimatedUnitValue: marketPrices.get(r.itemId) !== undefined ? Number(marketPrices.get(r.itemId)) : null,
  });

  const itemsByTrip = new Map<string, ReturnType<typeof mapItem>[]>();
  const unattachedItems: ReturnType<typeof mapItem>[] = [];
  for (const r of itemRows) {
    const item = mapItem(r);
    if (r.travelEventId) {
      const list = itemsByTrip.get(r.travelEventId) ?? [];
      list.push(item);
      itemsByTrip.set(r.travelEventId, list);
    } else {
      unattachedItems.push(item);
    }
  }

  const trips: LoadedTrip[] = tripRows.map((t) => ({
    id: t.id,
    destination: t.destination,
    departedAt: Math.floor(t.departedAt.getTime() / 1000),
    returnedAt: t.returnedAt ? Math.floor(t.returnedAt.getTime() / 1000) : null,
    durationSeconds: t.durationSeconds,
    items: itemsByTrip.get(t.id) ?? [],
  }));

  const unattached = {
    count: unattachedItems.length,
    spend: unattachedItems.reduce((s, i) => s + i.totalCost, 0),
    itemsBought: unattachedItems.reduce((s, i) => s + i.quantity, 0),
  };

  return { trips, unattached };
}

/**
 * Daily estimated trip profit series — the shared analytics definition
 * (identical to the dashboard's travelProfitSeries).
 */
function buildProfitSeries(trips: LoadedTrip[], from: number, to: number): Array<{ t: number; profit: number }> {
  return buildDailyTravelProfit(trips, from, to);
}

function findTopItem(trips: LoadedTrip[], marketPrices: Map<number, bigint>): { item: string | null; profit: number | null } {
  const perItem = new Map<string, { profit: number; known: boolean }>();
  for (const trip of trips) {
    for (const item of trip.items) {
      const name = item.itemName ?? `Item ${item.itemId}`;
      const price = marketPrices.get(item.itemId);
      const key = name;
      const current = perItem.get(key) ?? { profit: 0, known: true };
      if (price !== undefined) {
        current.profit += Number(price) * item.quantity - item.totalCost;
      } else {
        current.known = false;
      }
      perItem.set(key, current);
    }
  }
  const sorted = [...perItem.entries()]
    .filter(([, v]) => v.known)
    .sort((a, b) => b[1].profit - a[1].profit);
  const best = sorted[0];
  return best ? { item: best[0], profit: best[1].profit } : { item: null, profit: null };
}
