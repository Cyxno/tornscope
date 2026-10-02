import { getPrismaClient } from "../client.js";
import { routeLog } from "../normalizers/titles.js";

/**
 * Targeted data repair (2.1.2): remove DrugEvent + ConsumptionEvent rows
 * that the corrected drug-classification rules prove are NOT drug uses.
 *
 *   pnpm --filter @tornscope/database repair:drug-classification [--dry-run]
 *
 * Evidence-based, never name-based: a structured DrugEvent row is invalid
 * ONLY when its own raw provenance (the joined TimelineEvent row's real
 * category + title) no longer routes to the drugs domain under the
 * corrected routing (routeLog). Legitimate drug rows — including real
 * "Used Speed" / "Overdosed on Speed" history — can never match, because
 * their provenance still routes to drugs.
 *
 * Idempotent by construction: run 2 finds nothing left to change. The raw
 * archive (TimelineEvent), demo rows (no torn_log provenance join) and all
 * unrelated tables are untouched.
 */

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv);
  const db = getPrismaClient();

  // Every structured DrugEvent whose provenance is a stored raw log.
  const drugRows = await db.drugEvent.findMany({
    where: { source: "torn_log" },
    select: { userId: true, sourceRef: true, drugName: true },
  });
  const refs = [...new Set(drugRows.map((r) => r.sourceRef))];
  const users = [...new Set(drugRows.map((r) => r.userId))];
  const provenance = await db.timelineEvent.findMany({
    where: { sourceRef: { in: refs }, userId: { in: users }, type: "log" },
    select: { userId: true, sourceRef: true, category: true, title: true },
  });
  const provByKey = new Map(provenance.map((p) => [`${p.userId}\u0000${p.sourceRef}`, p]));

  const invalid: Array<{ userId: string; sourceRef: string; category: string; title: string; drugName: string | null }> = [];
  const stats = new Map<string, { rows: number; category: string; title: string }>();
  for (const row of drugRows) {
    const prov = provByKey.get(`${row.userId}\u0000${row.sourceRef}`);
    // No provenance row → cannot verify; leave untouched (never delete
    // without evidence).
    if (!prov) continue;
    if (routeLog(prov.category ?? "", prov.title) === "drugs") continue; // still valid
    const category = prov.category ?? "";
    invalid.push({ userId: row.userId, sourceRef: row.sourceRef, category, title: prov.title, drugName: row.drugName });
    const key = `${category} | ${prov.title} | ${row.drugName}`;
    const entry = stats.get(key) ?? { rows: 0, category, title: prov.title };
    entry.rows += 1;
    stats.set(key, entry);
  }

  console.log(`DrugEvent rows checked: ${drugRows.length} (torn_log provenance)`);
  if (invalid.length === 0) {
    console.log("Nothing to repair — every structured drug row routes to the drugs domain under the corrected rules.");
    return;
  }
  console.log(`Invalid drug rows found: ${invalid.length}`);
  for (const [key, entry] of [...stats.entries()].sort((a, b) => b[1].rows - a[1].rows)) {
    console.log(`  ${String(entry.rows).padStart(5)}  ${key}`);
  }

  // Side effects: the old drugs normalizer also wrote one ConsumptionEvent
  // (category "drug") per DrugEvent. Money is never written by the drugs
  // case — count any stray MoneyEvents for reporting before deleting.
  const invalidRefs = invalid.map((r) => r.sourceRef);
  const invalidUserIds = [...new Set(invalid.map((r) => r.userId))];
  const consumptionCount = await db.consumptionEvent.count({
    where: { sourceRef: { in: invalidRefs }, userId: { in: invalidUserIds } },
  });
  const moneyCount = await db.moneyEvent.count({
    where: { sourceRef: { in: invalidRefs }, userId: { in: invalidUserIds } },
  });
  console.log(`Associated ConsumptionEvent rows: ${consumptionCount}`);
  console.log(`Associated MoneyEvent rows (expected 0 — none written by the drugs case): ${moneyCount}`);
  if (moneyCount > 0) {
    console.error("Unexpected MoneyEvent rows share these sourceRefs — aborting (manual review required).");
    process.exit(1);
  }

  if (dryRun) {
    console.log("DRY RUN — nothing was changed. Re-run without --dry-run to apply.");
    return;
  }

  let deletedDrugs = 0;
  let deletedConsumption = 0;
  const BATCH = 200;
  for (let i = 0; i < invalid.length; i += BATCH) {
    const batch = invalid.slice(i, i + BATCH);
    const batchRefs = batch.map((r) => r.sourceRef);
    const batchUsers = [...new Set(batch.map((r) => r.userId))];
    const result = await db.$transaction(async (tx) => {
      const d1 = await tx.drugEvent.deleteMany({
        where: { sourceRef: { in: batchRefs }, userId: { in: batchUsers } },
      });
      const d2 = await tx.consumptionEvent.deleteMany({
        where: { sourceRef: { in: batchRefs }, userId: { in: batchUsers } },
      });
      return d1.count + d2.count;
    });
    deletedDrugs += result;
    deletedConsumption += result;
  }
  // Recount precisely for the report.
  const drugsLeft = await db.drugEvent.count({
    where: { sourceRef: { in: invalidRefs }, userId: { in: invalidUserIds } },
  });
  console.log(`Repair applied: ${invalid.length} invalid DrugEvent rows deleted (${drugsLeft} remaining = 0 expected), ${consumptionCount} ConsumptionEvent rows deleted.`);
  console.log("Raw TimelineEvent archive untouched. Re-run this command — it must now report nothing to repair.");
}

main()
  .then(() => getPrismaClient().$disconnect())
  .catch((err) => {
    console.error("repair failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
