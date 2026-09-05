import {
  resolveDateRange,
  type DateRangeInput,
  type TravelSummaryResponse,
  type TravelTripDto,
  type Paginated,
  type Provenance,
} from "@tornscope/shared";
import { assembleTrips, calculateTravelProfit, calculateTripEconomics } from "@tornscope/analytics";
import { bigintToNumber, getPrismaClient, loadMarketPrices } from "@tornscope/database";

/** Travel analytics: trips assembled from events + item purchases. */
export async function getTravelSummary(userId: string, rangeInput: DateRangeInput): Promise<TravelSummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);

  const marketPrices = await loadMarketPrices(db);
  const trips = await loadTrips(userId, range.from, range.to, marketPrices);

  const summary = calculateTravelProfit(trips, range.from, range.to);

  const topDest = summary.byDestination[0] ?? null;
  const topItem = findTopItem(trips, marketPrices);

  return {
    range: { from: range.from, to: range.to },
    trips: summary.trips,
    estimatedProfit: { value: summary.estimatedProfit, provenance: "estimated" },
    averageTripProfit: { value: summary.averageProfitPerTrip, provenance: "estimated" },
    profitPerHour: { value: summary.averageProfitPerHour, provenance: "estimated" },
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
  };
}

export async function getTravelHistory(userId: string, rangeInput: DateRangeInput, limit: number, cursor?: string): Promise<Paginated<TravelTripDto>> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  // Trips are small enough in practice to assemble from the window's rows;
  // cursor pagination slices the resulting DTOs by departure time.
  const trips = await loadTrips(userId, range.from, range.to, await loadMarketPrices(db));
  const marketPrices = await loadMarketPrices(db);

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

interface LoadedItem {
  id: string;
  itemId: number;
  itemName: string | null;
  category: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  occurredAt: number;
  destination: string | null;
  estimatedUnitValue: number | null;
}

async function loadTrips(userId: string, from: number, to: number, marketPrices: Map<number, bigint>) {
  const db = getPrismaClient();
  const [events, itemRows] = await Promise.all([
    db.travelEvent.findMany({
      where: { userId, departedAt: { gte: new Date((from - 7 * 86_400) * 1000), lte: new Date(to * 1000) } },
      orderBy: { departedAt: "asc" },
      select: { id: true, destination: true, departedAt: true, arrivedAt: true, returnedAt: true, status: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, occurredAt: { gte: new Date((from - 7 * 86_400) * 1000), lte: new Date(to * 1000) } },
      orderBy: { occurredAt: "asc" },
      select: { id: true, itemId: true, itemName: true, category: true, quantity: true, unitCost: true, totalCost: true, occurredAt: true, destination: true },
    }),
  ]);

  const items: LoadedItem[] = itemRows.map((r) => {
    const marketPrice = marketPrices.get(r.itemId);
    return {
      id: r.id,
      itemId: r.itemId,
      itemName: r.itemName,
      category: r.category,
      quantity: r.quantity,
      unitCost: bigintToNumber(r.unitCost) ?? 0,
      totalCost: bigintToNumber(r.totalCost) ?? 0,
      occurredAt: Math.floor(r.occurredAt.getTime() / 1000),
      destination: r.destination,
      estimatedUnitValue: marketPrice !== undefined ? Number(marketPrice) : null,
    };
  });

  return assembleTrips(
    events.map((e) => ({
      id: e.id,
      destination: e.destination,
      departedAt: Math.floor(e.departedAt.getTime() / 1000),
      arrivedAt: e.arrivedAt ? Math.floor(e.arrivedAt.getTime() / 1000) : null,
      returnedAt: e.returnedAt ? Math.floor(e.returnedAt.getTime() / 1000) : null,
      status: e.status,
    })),
    items
  );
}

/**
 * Daily estimated trip profit series. Profit = estimated resale value from
 * the Torn item catalog market price minus actual purchase spend; when a
 * price is unknown the item contributes -spend (pessimistic, clearly derived).
 */
function buildProfitSeries(trips: Array<{ departedAt: number; items: Array<{ estimatedUnitValue?: number | null; quantity: number; totalCost: number }> }>, from: number, to: number): Array<{ t: number; profit: number }> {
  const byDay = new Map<number, number>();
  for (const trip of trips) {
    if (trip.departedAt < from || trip.departedAt > to) continue;
    const d = new Date(trip.departedAt * 1000);
    const day = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
    let profit = 0;
    for (const item of trip.items) {
      const unitValue = item.estimatedUnitValue ?? null;
      profit += unitValue !== null ? unitValue * item.quantity - item.totalCost : -item.totalCost;
    }
    byDay.set(day, (byDay.get(day) ?? 0) + profit);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, profit: p }));
}

function findTopItem(trips: Array<{ items: Array<{ itemId: number; itemName: string | null; category: string; quantity: number; totalCost: number }> }>, marketPrices: Map<number, bigint>): { item: string | null; profit: number | null } {
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
