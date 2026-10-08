import { getPrismaClient } from "../client.js";
import { parseRewardComponents } from "../normalizers/rewards.js";
import { normalizeSpecialRewardLog } from "../normalizers/rewards.js";

/**
 * Reward-component repair (2.7.0) — backfills the generic non-cash reward
 * components onto ActivityEvents that predate the otherRewards column.
 *
 *   pnpm --filter @tornscope/database repair:reward-components [--dry-run]
 *
 * PASS 1 (UPDATE — component backfill): every casino/openable/domain/
 * special ActivityEvent whose otherRewards is still NULL gets its components
 * parsed from the RAW TimelineEvent payload (joined by sourceRef, the raw
 * archive is strictly READ-ONLY). Rows are stamped with the parsed array —
 * including the EMPTY array when the payload carries no components — so the
 * pass is IDEMPOTENT: a second run finds no NULL rows left. Cash columns are
 * never touched.
 *
 * PASS 2 (INSERT — missing special rows): special reward families (job/
 * company perks, stock benefit items, subscription rewards) that predate the
 * claim and have no ActivityEvent yet are inserted. Idempotent via the
 * (userId, source, sourceRef) unique; re-runs insert nothing.
 *
 * Dry-run prints exactly what would change; nothing is written.
 */

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv);
  const db = getPrismaClient();

  // ---- PASS 1: component backfill on existing rows ------------------------
  const backfillRows = await db.$queryRawUnsafe<Array<{
    id: string; domain: string; sourceRef: string; data: Record<string, unknown> | null;
  }>>(`
    SELECT ae.id, ae.domain, ae."sourceRef", te."metadata"->'data' AS data
    FROM "ActivityEvent" ae
    JOIN "TimelineEvent" te
      ON te."sourceRef" = ae."sourceRef" AND te."userId" = ae."userId" AND te."type" = 'log'
    WHERE ae."otherRewards" IS NULL
      AND ae.domain IN ('casino', 'openable', 'hunting', 'missions', 'racing', 'bounties', 'education', 'special')
    ORDER BY ae."occurredAt" ASC
    LIMIT 200000
  `);

  let withComponents = 0;
  let emptyStamped = 0;
  let malformed = 0;
  const updates: Array<{ id: string; otherRewards: unknown }> = [];
  for (const row of backfillRows) {
    const parsed = parseRewardComponents(row.data ?? {});
    malformed += parsed.malformed;
    if (parsed.components.length > 0) withComponents += 1;
    else emptyStamped += 1;
    updates.push({ id: row.id, otherRewards: parsed.components });
  }

  console.log(`PASS 1 (component backfill): ${backfillRows.length} row(s) with otherRewards IS NULL`);
  console.log(`  with parsed components: ${withComponents}`);
  console.log(`  stamped empty (payload carries none): ${emptyStamped}`);
  console.log(`  malformed components (counted, never priced): ${malformed}`);

  // ---- PASS 2: missing special-domain ActivityEvents ----------------------
  const specialRows = await db.$queryRawUnsafe<Array<{
    userId: string; sourceRef: string; occurredAt: Date; category: string; title: string; data: Record<string, unknown> | null;
  }>>(`
    SELECT te."userId", te."sourceRef", te."occurredAt", te."category", te."title", te."metadata"->'data' AS data
    FROM "TimelineEvent" te
    WHERE te."type" = 'log'
      AND (
        (te."category" = 'Company' AND te."title" = 'Company special gain item')
        OR (te."category" = 'Job' AND te."title" = 'Job special gain item')
        OR (te."category" = 'Stocks' AND te."title" = 'Stock special item')
        OR (te."category" = 'Donator' AND te."title" = 'Subscription reward')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ActivityEvent" ae
        WHERE ae."sourceRef" = te."sourceRef" AND ae."userId" = te."userId"
      )
    ORDER BY te."occurredAt" ASC
    LIMIT 100000
  `);

  const specialInserts = specialRows
    .map((r) => {
      const special = normalizeSpecialRewardLog(r.category, r.title, r.data ?? {});
      if (!special) return null;
      return {
        userId: r.userId,
        occurredAt: r.occurredAt,
        domain: "special",
        activityType: special.activityType,
        activityLabel: special.activityLabel,
        subtype: null,
        outcome: "received",
        game: null,
        wheel: null,
        cashInput: null,
        cashReward: null,
        pointsReward: null,
        tokensReward: null,
        otherRewards: special.components,
        netValue: null,
        valuation: "unpriced",
        provenance: "exact",
        source: "torn_log",
        sourceRef: r.sourceRef,
        metadata: (r.data ?? {}) as never,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  console.log(`PASS 2 (missing special rows): ${specialRows.length} raw row(s) unclaimed, ${specialInserts.length} would insert`);

  if (dryRun) {
    console.log("DRY RUN — nothing was changed. Re-run without --dry-run to apply.");
    return;
  }

  const BATCH = 500;
  let updated = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const result = await db.$executeRawUnsafe(
      `UPDATE "ActivityEvent" AS ae SET "otherRewards" = v.components::jsonb
       FROM (VALUES ${batch.map((_, j) => `($${j * 2 + 1}::text, $${j * 2 + 2}::jsonb)`).join(", ")}) AS v(id, components)
       WHERE ae.id = v.id`,
      ...batch.flatMap((u) => [u.id, JSON.stringify(u.otherRewards)]),
    );
    updated += result;
  }
  console.log(`PASS 1 applied: ${updated} row(s) stamped.`);

  let inserted = 0;
  let skippedVanishedUsers = 0;
  for (let i = 0; i < specialInserts.length; i += BATCH) {
    const batch = specialInserts.slice(i, i + BATCH) as never[];
    try {
      const result = await db.activityEvent.createMany({ data: batch, skipDuplicates: true });
      inserted += result.count;
    } catch (err) {
      // Concurrent user deletion mid-repair: retry row-by-row, skip vanished.
      if ((err as { code?: string }).code !== "P2003") throw err;
      for (const row of batch) {
        try {
          await db.activityEvent.create({ data: row });
          inserted += 1;
        } catch (rowErr) {
          if ((rowErr as { code?: string }).code !== "P2003") throw rowErr;
          skippedVanishedUsers += 1;
        }
      }
    }
  }
  if (skippedVanishedUsers > 0) {
    console.log(`Skipped ${skippedVanishedUsers} special rows whose user disappeared mid-repair.`);
  }
  console.log(`PASS 2 applied: ${inserted} special ActivityEvent row(s) inserted (skipDuplicates; raw archive untouched).`);
  console.log("Re-run — both passes must now report 0.");
}

main().catch((err) => {
  console.error("repair failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
