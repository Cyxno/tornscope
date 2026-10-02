import type { Prisma } from "../generated/client/client.js";
import { getPrismaClient } from "../client.js";
import { normalizeLogEntry } from "../normalizers/logs.js";
import type { TornUserLog } from "@tornscope/torn-api";

/**
 * Targeted additive repair (2.1.3): re-normalize stored raw logs whose
 * money movement was shadowed by an over-broad route (offshore bank
 * deposits/withdrawals and travel fees filed under the "Travel" category)
 * and insert the missing MoneyEvents.
 *
 *   pnpm --filter @tornscope/database repair:money-gaps [--dry-run]
 *
 * ADDITIVE ONLY: nothing is deleted; MoneyEvents are created through the
 * canonical idempotent upsert unique (userId, source, sourceRef), so a
 * second run inserts nothing. Only logs that (still) lack a MoneyEvent are
 * normalized; every other table is untouched.
 */

const GAP_TITLES = ["Offshore bank deposit", "Offshore bank withdraw", "Travel fee"];

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv);
  const db = getPrismaClient();

  const logs = await db.timelineEvent.findMany({
    where: { type: "log", title: { in: GAP_TITLES } },
    select: { userId: true, sourceRef: true, category: true, title: true, occurredAt: true, metadata: true },
    orderBy: { occurredAt: "asc" },
  });

  // Only rows whose raw payload still normalizes to a MoneyEvent and that
  // do not have one yet.
  let insertable = 0;
  type PlannedMoney = Prisma.MoneyEventCreateManyInput;
  const planned: PlannedMoney[] = [];
  for (const log of logs) {
    const existing = await db.moneyEvent.findFirst({ where: { userId: log.userId, sourceRef: log.sourceRef }, select: { id: true } });
    if (existing) continue;
    const raw = log.metadata as unknown as TornUserLog | null;
    if (!raw || typeof raw !== "object") continue;
    const writes = normalizeLogEntry(
      { ...raw, details: { ...raw.details, title: log.title, category: log.category ?? raw.details?.category ?? "" } },
      { itemNameById: new Map(), itemIdByName: new Map() }
    );
    for (const money of writes.moneyEvents) {
      planned.push({
        source: "torn_log",
        userId: log.userId,
        category: money.category,
        subcategory: money.subcategory,
        direction: money.direction,
        amount: money.amount,
        occurredAt: log.occurredAt,
        sourceRef: log.sourceRef,
        description: money.description,
      });
      insertable += 1;
    }
  }

  console.log(`Gap logs found: ${logs.length}; missing MoneyEvents to insert: ${insertable}`);
  for (const p of planned) {
    console.log(`  ${new Date(p.occurredAt).toISOString().slice(0, 16)}Z  ${p.category}/${p.direction}  ${p.amount < 0 ? "-" : "+"}${BigInt(Math.abs(Number(p.amount))).toLocaleString("en-US")}`);
  }
  if (insertable === 0) {
    console.log("Nothing to repair — every gap log already has its MoneyEvent.");
    return;
  }
  if (dryRun) {
    console.log("DRY RUN — nothing was changed. Re-run without --dry-run to apply.");
    return;
  }
  let inserted = 0;
  const BATCH = 100;
  for (let i = 0; i < planned.length; i += BATCH) {
    const result = await db.moneyEvent.createMany({ data: planned.slice(i, i + BATCH), skipDuplicates: true });
    inserted += result.count;
  }
  console.log(`Repair applied: ${inserted} MoneyEvent rows inserted (additive; raw archive untouched).`);
  console.log("Re-run this command — it must now report nothing to repair.");
}

main()
  .then(() => getPrismaClient().$disconnect())
  .catch((err) => {
    console.error("repair failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
