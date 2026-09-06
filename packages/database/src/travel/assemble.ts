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
  /**
   * Upper bound of the trip's real time window, used for purchase linking.
   * completed -> returnedAt; incomplete -> the NEXT departure (the flight
   * home was never logged but the player demonstrably left); in_progress ->
   * null (still abroad, window ends "now").
   * Without this, an incomplete trip from March would swallow every future
   * purchase with a matching destination.
   */
  windowEndedAt: Date | null;
}

export interface TripAssemblyResult {
  transitions: number;
  trips: number;
  unmatchedTransitions: number;
  linkedPurchases: number;
  /** Purchases whose stale link was cleared (no defensible trip anymore). */
  unlinkedPurchases: number;
  /** Trip ids after assembly (upserted + linked), for callers that report. */
}

const PURCHASE_WINDOW_SLACK_SECONDS = 6 * 3600;

/**
 * Pure purchase→trip matcher. A purchase matches a trip when it falls inside
 * the trip's window [departed - slack, windowEnd + slack] and the destinations
 * agree (whenever both sides know them). When several trips qualify, a CORE
 * window match (no slack) beats a slack-edge match, and the most RECENT
 * departure wins: chain flights reuse the same destination, and incomplete
 * (return never logged) trips must never swallow purchases that belong to
 * later trips.
 */
export function findMatchingTrip(
  trips: readonly AssembledTrip[],
  occurredAt: Date,
  destination: string | null,
  nowMs: number = Date.now()
): AssembledTrip | null {
  const ts = occurredAt.getTime();
  const candidates = trips
    .map((trip) => {
      const start = trip.departedAt.getTime() - PURCHASE_WINDOW_SLACK_SECONDS * 1000;
      // in_progress trips are genuinely still open; every other status has
      // a bounded window (returnedAt, or the next departure).
      const end = (trip.windowEndedAt?.getTime() ?? nowMs) + PURCHASE_WINDOW_SLACK_SECONDS * 1000;
      if (ts < start || ts > end) return null;
      if (destination && trip.destination && destination !== trip.destination) return null;
      const coreStart = trip.departedAt.getTime();
      const coreEnd = trip.windowEndedAt?.getTime() ?? nowMs;
      return { trip, core: ts >= coreStart && ts <= coreEnd };
    })
    .filter((c): c is { trip: AssembledTrip; core: boolean } => c !== null)
    .sort((a, b) => Number(b.core) - Number(a.core) || b.trip.departedAt.getTime() - a.trip.departedAt.getTime());
  return candidates[0]?.trip ?? null;
}

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
    trip.windowEndedAt = returnedAt;
  };

  for (const t of ordered) {
    const type = t.type as TravelTransitionType;
    switch (type) {
      case "DEPARTED_TORN": {
        // A departure while a trip is still open means the previous trip's
        // return was never logged in the collected history: finalize it as
        // incomplete with only real evidence attached. Its window ends at
        // this departure — the player demonstrably left before this flight.
        if (open) {
          open.status = "incomplete";
          open.windowEndedAt = t.occurredAt;
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
          windowEndedAt: null,
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
  // outside targeted deletions) are removed so no ghosts survive. With NO
  // transitions at all the assembly produced nothing — skip the sweep: a
  // transient empty transition set (concurrent renormalize delete window)
  // must not wipe every stored trip.
  if (tripIds.length > 0) {
    await db.travelEvent.deleteMany({
      where: { userId, source: "trip", id: { notIn: tripIds } },
    });
  }

  // Link abroad purchases to their trip. A purchase matches a trip when it
  // falls inside the trip's window [departed - slack, windowEnd + slack] and
  // the destinations agree (whenever both sides know them). When several
  // trips qualify, the most RECENT departure wins: chain flights reuse the
  // same destination, and incomplete (return never logged) trips must never
  // swallow purchases that belong to later trips. Strictly user-scoped:
  // another account's purchases must never attach to this user's trips.
  const purchases = await db.travelItemEvent.findMany({
    where: { userId },
    select: { id: true, occurredAt: true, destination: true, travelEventId: true },
  });
  let linked = 0;
  let unlinked = 0;
  for (const purchase of purchases) {
    const match = findMatchingTrip(trips, purchase.occurredAt, purchase.destination);
    const matchId = match
      ? (
          await db.travelEvent.findUnique({
            where: { userId_source_sourceRef: { userId, source: "trip", sourceRef: `trip:${match.departedSourceRef}` } },
            select: { id: true },
          })
        )?.id ?? null
      : null;
    if (matchId !== purchase.travelEventId) {
      await db.travelItemEvent.update({ where: { id: purchase.id }, data: { travelEventId: matchId } });
      if (matchId) linked += 1;
      else unlinked += 1;
    }
  }

  return { transitions: transitions.length, trips: trips.length, unmatchedTransitions: unmatched, linkedPurchases: linked, unlinkedPurchases: unlinked };
}
