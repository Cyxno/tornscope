import type { Provenance } from "@tornscope/shared";
import { TRAVEL_ITEM_CATEGORIES, type TravelItemCategory } from "@tornscope/shared";

/**
 * Travel profitability calculations.
 *
 * Resale values are ESTIMATES sourced from the Torn item catalog market
 * price; realized values are only used when actual sale data exists.
 * Every aggregate carries provenance so the UI can label it correctly.
 */

export interface TravelItemLike {
  id: string;
  category: TravelItemCategory | string;
  itemId: number;
  itemName: string | null;
  quantity: number;
  unitCost: number;
  totalCost: number;
  /** Estimated unit resale value (Torn market price). Optional. */
  estimatedUnitValue?: number | null;
  estimatedTotalValue?: number | null;
  realizedTotalValue?: number | null;
}

export interface TravelTripLike {
  id: string;
  destination: string;
  departedAt: number;
  returnedAt: number | null;
  durationSeconds: number | null;
  items: TravelItemLike[];
}

export interface DestinationAnalytics {
  destination: string;
  trips: number;
  itemsBought: number;
  totalSpend: number;
  estimatedRevenue: number | null;
  estimatedProfit: number | null;
  averageProfitPerTrip: number | null;
  averageProfitPerHour: number | null;
}

export interface TravelProfitSummary {
  trips: number;
  totalItemsBought: number;
  totalSpend: number;
  estimatedRevenue: number | null;
  estimatedProfit: number | null;
  averageProfitPerTrip: number | null;
  averageProfitPerHour: number | null;
  byDestination: DestinationAnalytics[];
  byCategory: Array<{
    category: string;
    quantity: number;
    spend: number;
    estimatedValue: number | null;
  }>;
  mostProfitableDestination: DestinationAnalytics | null;
  provenance: Provenance;
}

const HOUR = 3600;

export function calculateProfitPerHour(profit: number, durationSeconds: number | null | undefined): number | null {
  if (durationSeconds === null || durationSeconds === undefined || durationSeconds <= 0) return null;
  return (profit / durationSeconds) * HOUR;
}

export function tripDurationSeconds(trip: TravelTripLike): number | null {
  if (trip.durationSeconds !== null && trip.durationSeconds !== undefined && trip.durationSeconds > 0) {
    return trip.durationSeconds;
  }
  if (trip.returnedAt !== null && trip.returnedAt > trip.departedAt) {
    return trip.returnedAt - trip.departedAt;
  }
  return null;
}

function itemEstimatedValue(item: TravelItemLike): number | null {
  if (item.realizedTotalValue !== null && item.realizedTotalValue !== undefined) return item.realizedTotalValue;
  if (item.estimatedTotalValue !== null && item.estimatedTotalValue !== undefined) return item.estimatedTotalValue;
  if (item.estimatedUnitValue !== null && item.estimatedUnitValue !== undefined) {
    return item.estimatedUnitValue * item.quantity;
  }
  return null;
}

/** Item-level estimated profit (null when no price data is available). */
export function calculateItemProfit(item: TravelItemLike): number | null {
  const value = itemEstimatedValue(item);
  if (value === null) return null;
  return value - item.totalCost;
}

/** Aggregate travel trips into a profitability summary. */
export function calculateTravelProfit(trips: readonly TravelTripLike[], from?: number, to?: number): TravelProfitSummary {
  const inRange = trips.filter((t) => t.departedAt >= (from ?? -Infinity) && t.departedAt <= (to ?? Infinity));

  let totalSpend = 0;
  let totalItemsBought = 0;
  let revenueSum = 0;
  let revenueKnown = true;
  // Per-hour uses the SAME trip subset for profit and duration: trips without
  // a known duration (e.g. still in flight) contribute to neither side.
  let timedRevenueSum = 0;
  let timedSpendSum = 0;
  let timedRevenueKnown = true;
  let durationSum = 0;

  const destMap = new Map<string, DestinationAnalytics & { _revenueKnown: boolean; _durationSum: number; _timedRevenue: number; _timedSpend: number; _timedRevenueKnown: boolean }>();
  const catMap = new Map<string, { quantity: number; spend: number; estimatedValue: number | null }>();

  for (const trip of inRange) {
    const dest =
      destMap.get(trip.destination) ??
      (destMap.set(
        trip.destination,
        {
          destination: trip.destination,
          trips: 0,
          itemsBought: 0,
          totalSpend: 0,
          estimatedRevenue: 0,
          estimatedProfit: 0,
          averageProfitPerTrip: null,
          averageProfitPerHour: null,
          _revenueKnown: true,
          _durationSum: 0,
          _timedRevenue: 0,
          _timedSpend: 0,
          _timedRevenueKnown: true,
        }
      ), destMap.get(trip.destination)!);

    dest.trips += 1;
    const duration = tripDurationSeconds(trip);
    const timed = duration !== null;
    if (timed) {
      durationSum += duration;
      dest._durationSum += duration;
    }

    let tripRevenue = 0;
    let tripRevenueKnown = true;
    let tripSpend = 0;

    for (const item of trip.items) {
      const spend = item.totalCost;
      const value = itemEstimatedValue(item);
      totalSpend += spend;
      totalItemsBought += item.quantity;
      tripSpend += spend;
      dest.totalSpend += spend;
      dest.itemsBought += item.quantity;

      const cat =
        catMap.get(String(item.category)) ?? catMap.set(String(item.category), { quantity: 0, spend: 0, estimatedValue: null }).get(String(item.category))!;
      cat.quantity += item.quantity;
      cat.spend += spend;
      if (value !== null) {
        cat.estimatedValue = (cat.estimatedValue ?? 0) + value;
        tripRevenue += value;
      } else {
        tripRevenueKnown = false;
      }
    }

    if (tripRevenueKnown) {
      revenueSum += tripRevenue;
      dest.estimatedRevenue! += tripRevenue;
      dest.estimatedProfit! += tripRevenue - tripSpend;
    } else {
      revenueKnown = false;
      dest._revenueKnown = false;
    }
    // Timed (known-duration) subset for the per-hour figure.
    if (timed) {
      timedSpendSum += tripSpend;
      dest._timedSpend += tripSpend;
      if (tripRevenueKnown) {
        timedRevenueSum += tripRevenue;
        dest._timedRevenue += tripRevenue;
      } else {
        timedRevenueKnown = false;
        dest._timedRevenueKnown = false;
      }
    }
  }

  const timedProfit = timedRevenueKnown ? timedRevenueSum - timedSpendSum : null;
  const byDestination = [...destMap.values()].map((d) => {
    const profit = d._revenueKnown ? d.estimatedRevenue! - d.totalSpend : null;
    const destTimedProfit = d._timedRevenueKnown ? d._timedRevenue - d._timedSpend : null;
    return {
      destination: d.destination,
      trips: d.trips,
      itemsBought: d.itemsBought,
      totalSpend: d.totalSpend,
      estimatedRevenue: d._revenueKnown ? d.estimatedRevenue : null,
      estimatedProfit: profit,
      averageProfitPerTrip: profit !== null && d.trips > 0 ? profit / d.trips : null,
      // Per-hour: profit and hours over the same known-duration trips —
      // null only when no durations are known (or profit is unknown).
      averageProfitPerHour: destTimedProfit !== null && d._durationSum > 0 ? (destTimedProfit / d._durationSum) * HOUR : null,
    };
  }).sort((a, b) => (b.estimatedProfit ?? b.totalSpend * -1) - (a.estimatedProfit ?? a.totalSpend * -1));

  const estimatedProfit = revenueKnown ? revenueSum - totalSpend : null;
  const byCategory = [...catMap.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.spend - a.spend);

  return {
    trips: inRange.length,
    totalItemsBought,
    totalSpend,
    estimatedRevenue: revenueKnown ? revenueSum : null,
    estimatedProfit,
    averageProfitPerTrip: estimatedProfit !== null && inRange.length > 0 ? estimatedProfit / inRange.length : null,
    averageProfitPerHour: timedProfit !== null && durationSum > 0 ? (timedProfit / durationSum) * HOUR : null,
    byDestination,
    byCategory,
    mostProfitableDestination: byDestination.find((d) => d.estimatedProfit !== null) ?? null,
    provenance: "estimated",
  };
}

/** Per-trip economics used by the travel history table. */
export interface TripEconomics {
  durationSeconds: number | null;
  spend: number;
  estimatedRevenue: number | null;
  estimatedProfit: number | null;
  profitPerHour: number | null;
  provenance: Provenance;
}

export function calculateTripEconomics(trip: TravelTripLike): TripEconomics {
  const spend = trip.items.reduce((sum, item) => sum + item.totalCost, 0);
  let revenue = 0;
  let revenueKnown = trip.items.length > 0;
  for (const item of trip.items) {
    const value = itemEstimatedValue(item);
    if (value === null) revenueKnown = false;
    else revenue += value;
  }
  const duration = tripDurationSeconds(trip);
  const estimatedProfit = revenueKnown ? revenue - spend : null;
  return {
    durationSeconds: duration,
    spend,
    estimatedRevenue: revenueKnown ? revenue : null,
    estimatedProfit,
    profitPerHour: estimatedProfit !== null ? calculateProfitPerHour(estimatedProfit, duration) : null,
    provenance: revenueKnown ? "estimated" : "derived",
  };
}

/**
 * Assemble trips from raw travel events + item purchases.
 * Departure rows start a trip; the next arrival/return with the same
 * destination closes it. Item purchases attach to the trip whose
 * [departedAt, returnedAt] window contains them and whose destination
 * matches (falling back to the enclosing window only).
 */
export interface TravelEventLike {
  id: string;
  destination: string;
  departedAt: number;
  arrivedAt: number | null;
  returnedAt: number | null;
  status: string;
}

export interface AssembledTrip extends TravelTripLike {
  open: boolean;
}

export function assembleTrips(events: readonly TravelEventLike[], items: readonly (TravelItemLike & { occurredAt: number; destination: string | null })[]): AssembledTrip[] {
  // A row that already carries returnedAt is a complete self-contained trip
  // (e.g. reconciled from /user/travel). Rows without returnedAt split into
  // departures (open trips) and arrival/return closers.
  const departures = events
    .filter((e) => e.returnedAt !== null || (e.status !== "arrived" && e.status !== "returned"))
    .sort((a, b) => a.departedAt - b.departedAt);
  const closers = events
    .filter((e) => e.returnedAt === null && (e.status === "arrived" || e.status === "returned"))
    .map((e) => ({ ts: e.returnedAt ?? e.arrivedAt ?? e.departedAt, destination: e.destination }))
    .sort((a, b) => a.ts - b.ts);

  const trips: AssembledTrip[] = departures.map((departure) => {
    if (departure.returnedAt !== null) {
      return {
        id: departure.id,
        destination: departure.destination,
        departedAt: departure.departedAt,
        returnedAt: departure.returnedAt,
        durationSeconds: null,
        items: [],
        open: false,
      };
    }
    const closer = closers.find((c) => c.ts >= departure.departedAt && c.destination === departure.destination);
    const genericCloser = closers.find((c) => c.ts >= departure.departedAt);
    const returnedAt = (closer ?? genericCloser)?.ts ?? null;
    return {
      id: departure.id,
      destination: departure.destination,
      departedAt: departure.departedAt,
      returnedAt,
      durationSeconds: null,
      items: [],
      open: returnedAt === null,
    };
  });

  for (const item of items) {
    const trip =
      trips.find((t) => t.destination === item.destination && item.occurredAt >= t.departedAt && (t.returnedAt === null || item.occurredAt <= t.returnedAt + 12 * HOUR)) ??
      trips.find((t) => item.occurredAt >= t.departedAt && (t.returnedAt === null || item.occurredAt <= t.returnedAt + 12 * HOUR));
    if (trip) trip.items.push(item);
  }

  return trips;
}
