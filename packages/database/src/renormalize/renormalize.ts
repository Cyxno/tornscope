import { getPrismaClient, bigintToNumber } from "../client.js";
import { loadItemIdByName, loadItemNameMap, loadItemTypeMap, loadMarketPrices } from "../repositories/catalog.js";
import { normalizeLogEntry } from "../normalizers/logs.js";
import { insertConsumptionEvents, insertCrimeEvents, insertDrugEvents, insertMoneyEvents, insertRehabEvents, insertTimelineEvents, insertTravelItemEvents, insertTravelTransitions } from "../repositories/ingest.js";
import { assembleTripsFromTransitions } from "../travel/assemble.js";
import type { TornUserLog } from "@tornscope/torn-api";

/**
 * Re-normalization: rebuild every derived event table from the raw log
 * payloads already stored on the timeline — no Torn API calls, no raw data
 * loss.
 *
 *   pnpm torn:renormalize [--user <id|email|tornName>] [--dry-run]
 *
 * - Deletes ONLY derived structured rows for the selected user (MoneyEvent,
 *   DrugEvent, ConsumptionEvent, RehabEvent, TravelItemEvent,
 *   TravelTransition, TravelEvent).
 * - Keeps TimelineEvent (the raw archive), networth snapshots, credentials
 *   and everything belonging to other users (demo data included).
 * - Re-runs the current normalizer over every stored log, then re-assembles
 *   travel trips from transitions.
 * - Idempotent: running it twice produces identical counts.
 */

const BATCH = 300;

function parseArgs(argv: string[]): { user?: string; dryRun: boolean } {
  const args = { dryRun: false } as { user?: string; dryRun: boolean };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--user") args.user = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function resolveUser(db: ReturnType<typeof getPrismaClient>, selector?: string) {
  if (selector) {
    const byId = await db.user.findUnique({ where: { id: selector } });
    if (byId) return byId;
    const byEmail = await db.user.findUnique({ where: { email: selector } });
    if (byEmail) return byEmail;
    const all = await db.user.findMany({ include: { tornAccount: true } });
    const byName = all.find((u) => u.tornAccount?.tornId === Number(selector) || u.displayName.toLowerCase() === selector.toLowerCase());
    if (byName) return byName;
    throw new Error(`no user matches "${selector}"`);
  }
  const owners = await db.user.findMany({
    where: { isDemo: false },
    include: { tornAccount: true },
    orderBy: { createdAt: "asc" },
  });
  if (owners.length === 0) throw new Error("no real (non-demo) user exists");
  if (owners.length > 1) {
    console.log("Multiple real users exist; pick one with --user <id|email|tornId>:");
    for (const u of owners) console.log(`  ${u.id}  ${u.displayName}  tornId=${u.tornAccount?.tornId ?? "?"}`);
    process.exit(1);
  }
  return owners[0]!;
}

async function countAll(db: ReturnType<typeof getPrismaClient>, userId: string) {
  const [money, drugs, consumption, crimes, rehab, travelItems, transitions, trips, legacyTravel, timeline] = await Promise.all([
    db.moneyEvent.count({ where: { userId } }),
    db.drugEvent.count({ where: { userId } }),
    db.consumptionEvent.count({ where: { userId } }),
    db.crimeEvent.count({ where: { userId } }),
    db.rehabEvent.count({ where: { userId } }),
    db.travelItemEvent.count({ where: { userId } }),
    db.travelTransition.count({ where: { userId } }),
    db.travelEvent.count({ where: { userId, source: "trip" } }),
    db.travelEvent.count({ where: { userId, source: { notIn: ["trip", "demo"] } } }),
    db.timelineEvent.count({ where: { userId, type: "log" } }),
  ]);
  return { money, drugs, consumption, crimes, rehab, travelItems, transitions, trips, legacyTravel, timeline };
}

async function main(): Promise<void> {
  const { user: userSelector, dryRun } = parseArgs(process.argv);
  const db = getPrismaClient();
  const user = await resolveUser(db, userSelector);

  console.log(`\n=== TornScope re-normalization ===`);
  console.log(`user: ${user.id} "${user.displayName}"${dryRun ? " (DRY RUN — nothing written)" : ""}`);

  const before = await countAll(db, user.id);
  console.log("before:", JSON.stringify(before));

  // The raw archive: every log entry with its full original payload.
  const rows = await db.timelineEvent.findMany({
    where: { userId: user.id, type: "log" },
    select: { metadata: true },
    orderBy: [{ occurredAt: "asc" }],
  });
  const logs = rows
    .map((r) => r.metadata as unknown as TornUserLog | null)
    .filter((m): m is TornUserLog => !!m && typeof m === "object" && m.details !== undefined);
  console.log(`raw logs to reprocess: ${logs.length} (${rows.length - logs.length} rows skipped: missing payload)`);

  const [itemNameById, itemTypeById, itemMarketPriceById, itemIdByName] = await Promise.all([
    loadItemNameMap(db),
    loadItemTypeMap(db),
    loadMarketPrices(db),
    loadItemIdByName(db),
  ]);

  // Re-run normalization in memory first so a crash or a bad normalizer
  // cannot leave the derived tables half-deleted.
  const rebuilt = { money: 0, drugs: 0, consumption: 0, crimes: 0, rehab: 0, travelItems: 0, transitions: 0, timeline: 0 };
  const normalized = logs.map((log) => {
    const writes = normalizeLogEntry(log, { itemNameById, itemTypeById, itemMarketPriceById, itemIdByName });
    rebuilt.money += writes.moneyEvents.length;
    rebuilt.drugs += writes.drugEvents.length;
    rebuilt.consumption += writes.consumptionEvents.length;
    rebuilt.crimes += writes.crimeEvents.length;
    rebuilt.rehab += writes.rehabEvents.length;
    rebuilt.travelItems += writes.travelItemEvents.length;
    rebuilt.transitions += writes.travelTransitions.length;
    rebuilt.timeline += writes.timelineEvents.length;
    return writes;
  });

  console.log("normalized writes:", JSON.stringify(rebuilt));
  if (dryRun) {
    console.log("\ndry run complete — no data changed.\n");
    process.exit(0);
  }

  // Derived tables only. TimelineEvent (raw archive), snapshots, credentials
  // and other users' rows are never touched.
  const deleted = await db.$transaction(async (tx) => {
    const d = {
      money: await tx.moneyEvent.deleteMany({ where: { userId: user.id } }),
      drugs: await tx.drugEvent.deleteMany({ where: { userId: user.id } }),
      consumption: await tx.consumptionEvent.deleteMany({ where: { userId: user.id } }),
      crimes: await tx.crimeEvent.deleteMany({ where: { userId: user.id } }),
      rehab: await tx.rehabEvent.deleteMany({ where: { userId: user.id } }),
      travelItems: await tx.travelItemEvent.deleteMany({ where: { userId: user.id } }),
      transitions: await tx.travelTransition.deleteMany({ where: { userId: user.id } }),
      trips: await tx.travelEvent.deleteMany({ where: { userId: user.id, source: { not: "demo" } } }),
    };
    return d;
  });
  console.log(
    `deleted derived rows: money=${deleted.money.count} drugs=${deleted.drugs.count} consumption=${deleted.consumption.count} crimes=${deleted.crimes.count} rehab=${deleted.rehab.count} travelItems=${deleted.travelItems.count} transitions=${deleted.transitions.count} travel=${deleted.trips.count}`
  );

  // Re-insert in chronological batches.
  for (let i = 0; i < normalized.length; i += BATCH) {
    const chunk = normalized.slice(i, i + BATCH);
    const merged = {
      timelineEvents: chunk.flatMap((w) => w.timelineEvents),
      drugEvents: chunk.flatMap((w) => w.drugEvents),
      consumptionEvents: chunk.flatMap((w) => w.consumptionEvents),
      crimeEvents: chunk.flatMap((w) => w.crimeEvents),
      rehabEvents: chunk.flatMap((w) => w.rehabEvents),
      travelTransitions: chunk.flatMap((w) => w.travelTransitions),
      travelItemEvents: chunk.flatMap((w) => w.travelItemEvents),
      moneyEvents: chunk.flatMap((w) => w.moneyEvents),
    };
    await insertTimelineEvents(db, user.id, merged.timelineEvents);
    await insertDrugEvents(db, user.id, merged.drugEvents);
    await insertConsumptionEvents(db, user.id, merged.consumptionEvents);
    await insertCrimeEvents(db, user.id, merged.crimeEvents);
    await insertRehabEvents(db, user.id, merged.rehabEvents);
    await insertTravelTransitions(db, user.id, merged.travelTransitions);
    await insertTravelItemEvents(db, user.id, merged.travelItemEvents);
    await insertMoneyEvents(db, user.id, merged.moneyEvents);
    process.stdout.write(`\rinserted batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(normalized.length / BATCH)}`);
  }
  process.stdout.write("\n");

  const assembly = await assembleTripsFromTransitions(db, user.id);
  console.log(
    `trip assembly: transitions=${assembly.transitions} trips=${assembly.trips} unmatchedTransitions=${assembly.unmatchedTransitions} linkedPurchases=${assembly.linkedPurchases} unlinkedPurchases=${assembly.unlinkedPurchases}`
  );

  const after = await countAll(db, user.id);
  console.log("after: ", JSON.stringify(after));

  const moneyByDirection = await db.moneyEvent.groupBy({
    by: ["direction"],
    where: { userId: user.id },
    _count: { _all: true },
    _sum: { amount: true },
  });
  for (const d of moneyByDirection) {
    console.log(`  money ${d.direction.padEnd(8)} n=${String(d._count._all).padStart(6)} sum=${bigintToNumber(d._sum.amount ?? 0n)}`);
  }

  const consumptionByCategory = await db.consumptionEvent.groupBy({
    by: ["category"],
    where: { userId: user.id },
    _count: { _all: true },
    _sum: { totalValue: true },
  });
  for (const c of consumptionByCategory) {
    console.log(`  consumption ${c.category.padEnd(10)} n=${String(c._count._all).padStart(6)} value=${bigintToNumber(c._sum.totalValue ?? 0n)}`);
  }

  console.log("=== re-normalization complete ===\n");
  process.exit(0);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("renormalize failed:", err);
    process.exit(1);
  });
