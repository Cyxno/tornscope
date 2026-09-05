import type { PrismaClientType } from "../client.js";
import type { TravelTransitionType } from "../normalizers/titles.js";

/**
 * Step B of the travel model: assemble TravelTransition rows (step A —
 * individual parsed transitions) into complete trips.
 *
 * A trip is built strictly from chronological evidence:
 *   DEPARTED_TORN -> ARRIVED_ABROAD -> [ITEM_PURCHASE*] -> DEPARTED_ABROAD -> ARRIVED_TORN
 *
 * departedAt is NEVER fabricated from an arrival timestamp: a trip only
 * exists when a real departure transition evidences it. Transitions that do
 * not fit the state machine (e.g. an arrival whose departure predates the
 * collected history) are counted as unmatched, not guessed away.
 *
 * Re-running is idempotent: trips are upserted with the stable sourceRef
 * `trip:<departure log ref>`, purchases are linked by country + time window,
 * and assembly rows without surviving evidence are removed.
 */

export interface AssembledTrip {
  destination: string | null;
  destinationCountryId: number | null;
  departedAt: Date;
  departedSourceRef: string;
  arrivedAt: Date | null;
  returnedAt: Date | null;
  status: "completed" | "in_progress" | "incomplete";
}

export interface TripAssemblyResult {
  transitions: number;
  trips: number;
  unmatchedTransitions: number;
  linkedPurchases: number;
  /** Trip ids after assembly (upserted + linked), for callers that report. */
}

const PURCHASE_WINDOW_SLACK_SECONDS = 6 * 3600;

export function assembleTripsFromTransitionRows(
  transitions: Array<{ id: string; occurredAt: Date; type: string; country: string | null; countryId: number | null }>
): { trips: AssembledTrip[]; unmatched: number } {
  const ordered = [...transitions].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));

  const trips: AssembledTrip[] = [];
  let open: AssembledTrip | null = null;
  let unmatched = 0;

  const close = (trip: AssembledTrip, returnedAt: Date, status: AssembledTrip["status"]): void => {
    trip.returnedAt = returnedAt;
    trip.status = status;
  };

  for (const t of ordered) {
    const type = t.type as TravelTransitionType;
    switch (type) {
      case "DEPARTED_TORN": {
        // A departure while a trip is still open means the previous trip's
        // return was never logged in the collected history: finalize it as
        // incomplete with only real evidence attached.
        if (open) {
          open.status = "incomplete";
          trips.push(open);
        }
        open = {
          destination: t.country,
          destinationCountryId: t.countryId,
          departedAt: t.occurredAt,
          departedSourceRef: t.id,
          arrivedAt: null,
          returnedAt: null,
          status: "in_progress",
        };
        break;
      }
      case "ARRIVED_ABROAD": {
        if (open) {
          // Attach the landing; if it does not match the planned destination
          // the departure still governs (metadata keeps both).
          open.arrivedAt = t.occurredAt;
          if (open.destination === null && t.country) open.destination = t.country;
        } else {
          unmatched += 1;
        }
        break;
      }
      case "DEPARTED_ABROAD": {
        if (!open) unmatched += 1;
        // Heading home — nothing to record; ARRIVED_TORN closes the trip.
        break;
      }
      case "ARRIVED_TORN": {
        if (open) {
          close(open, t.occurredAt, "completed");
          trips.push(open);
          open = null;
        } else {
          unmatched += 1;
        }
        break;
      }
      case "ITEM_PURCHASE":
        // Purchases attach to trips during the linking pass.
        break;
      default:
        unmatched += 1;
    }
  }
  if (open) trips.push(open); // still abroad / mid-trip

  return { trips, unmatched };
}

/**
 * Rebuild all assembled trips for a user from their stored transitions and
 * relink abroad purchases. Safe to run any time; derived state only.
 */
export async function assembleTripsFromTransitions(db: PrismaClientType, userId: string): Promise<TripAssemblyResult> {
  const transitions = await db.travelTransition.findMany({
    where: { userId, type: { not: "ITEM_PURCHASE" } },
    select: { id: true, occurredAt: true, type: true, country: true, countryId: true },
  });

  const { trips, unmatched } = assembleTripsFromTransitionRows(transitions);

  // Upsert every assembled trip under its stable identity.
  const tripIds: string[] = [];
  for (const trip of trips) {
    const sourceRef = `trip:${trip.departedSourceRef}`;
    const durationSeconds =
      trip.returnedAt !== null ? Math.round((trip.returnedAt.getTime() - trip.departedAt.getTime()) / 1000) : null;
    const row = await db.travelEvent.upsert({
      where: { userId_source_sourceRef: { userId, source: "trip", sourceRef } },
      create: {
        userId,
        destination: trip.destination ?? "Unknown",
        departedAt: trip.departedAt,
        arrivedAt: trip.arrivedAt,
        returnedAt: trip.returnedAt,
        durationSeconds,
        status: trip.status,
        source: "trip",
        sourceRef,
      },
      update: {
        destination: trip.destination ?? "Unknown",
        departedAt: trip.departedAt,
        arrivedAt: trip.arrivedAt,
        returnedAt: trip.returnedAt,
        durationSeconds,
        status: trip.status,
      },
    });
    tripIds.push(row.id);
  }

  // Assembly rows whose departure transition disappeared (should not happen
  // outside targeted deletions) are removed so no ghosts survive.
  await db.travelEvent.deleteMany({
    where: { userId, source: "trip", ...(tripIds.length > 0 ? { id: { notIn: tripIds } } : {}) },
  });

  // Link abroad purchases to their trip: same destination (when known on
  // either side) and purchase time within [departed - slack, returned + slack].
  const purchases = await db.travelItemEvent.findMany({
    where: { userId, travelEventId: null },
    select: { id: true, occurredAt: true, destination: true },
  });
  let linked = 0;
  for (const purchase of purchases) {
    const ts = purchase.occurredAt.getTime();
    const match = trips.find((trip) => {
      const start = trip.departedAt.getTime() - PURCHASE_WINDOW_SLACK_SECONDS * 1000;
      const end = (trip.returnedAt?.getTime() ?? Date.now()) + PURCHASE_WINDOW_SLACK_SECONDS * 1000;
      if (ts < start || ts > end) return false;
      if (purchase.destination && trip.destination && purchase.destination !== trip.destination) return false;
      return true;
    });
    if (match) {
      const row = await db.travelEvent.findUnique({
        where: { userId_source_sourceRef: { userId, source: "trip", sourceRef: `trip:${match.departedSourceRef}` } },
        select: { id: true },
      });
      if (row) {
        await db.travelItemEvent.update({ where: { id: purchase.id }, data: { travelEventId: row.id } });
        linked += 1;
      }
    }
  }

  return { transitions: transitions.length, trips: trips.length, unmatchedTransitions: unmatched, linkedPurchases: linked };
}
