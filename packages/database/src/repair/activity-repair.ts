import { getPrismaClient } from "../client.js";
import { normalizeCasinoLog as normalizeCasino } from "../normalizers/casino.js";
import { normalizeOpenableLog } from "../normalizers/openables.js";
import { routeLog } from "../normalizers/titles.js";



/**
 * Activity & Rewards repair (2.4.0) — backfill ActivityEvents from the raw
 * TimelineEvent archive using the current normalizers.
 *
 *   pnpm --filter @tornscope/database repair:activities [--dry-run]
 *
 * Idempotent via (userId, source, sourceRef) unique; raw archive untouched;
 * dry-run prints candidate/recognized/unsupported counts first. Also prints
 * the money-reconciliation diagnostic for casino activities with exact cash
 * (activity cash delta vs MoneyEvent casino delta) — differences are
 * reported, never patched.
 */

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

interface Candidate {
  userId: string;
  sourceRef: string;
  occurredAt: Date;
  title: string;
  category: string;
  data: Record<string, unknown>;
  domain: "casino" | "openable";
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv);
  const db = getPrismaClient();

  // Candidate rows: casino/openable-routed raw logs that do not yet have an
  // ActivityEvent with the same sourceRef. Candidates are a deliberate
  // SUPERSET of what the normalizers claim (both casino categories, every
  // item-use log with a reward-shaped payload key); the normalizers decide
  // recognition and the rest lands in the unsupported/ambiguous buckets,
  // which is the unrecognized-value diagnostic.
  const rows = await db.$queryRawUnsafe<Array<{
    userId: string; sourceRef: string; occurredAt: Date; category: string; title: string; metadata: unknown;
  }>>(`
    SELECT te."userId", te."sourceRef", te."occurredAt", te."category", te."title", te."metadata"
    FROM "TimelineEvent" te
    WHERE te."type" = 'log'
      AND (
        te."category" ILIKE '%casino%'
        OR (te."category" = 'Item use' AND (
          te."metadata"->'data' ? 'items'
          OR te."metadata"->'data' ? 'item2'
          OR te."metadata"->'data' ? 'money'
          OR te."metadata"->'data' ? 'points'
        ))
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ActivityEvent" ae
        WHERE ae."sourceRef" = te."sourceRef" AND ae."userId" = te."userId"
      )
    ORDER BY te."occurredAt" ASC
    LIMIT 200000
  `);

  const candidates: Candidate[] = [];
  const stats = { recognized: 0, unsupported: 0, ambiguous: 0 };
  const byTitle = new Map<string, number>();
  for (const row of rows) {
    const data = (row.metadata as { data?: Record<string, unknown> } | null)?.data ?? {};
    if (routeLog(row.category, row.title) === "casino") {
      const casino = normalizeCasino(row.category, row.title, data);
      if (casino) {
        stats.recognized += 1;
        candidates.push({ userId: row.userId, sourceRef: row.sourceRef, occurredAt: row.occurredAt, title: row.title, category: row.category, data, domain: "casino" });
        continue;
      }
      stats.unsupported += 1;
      byTitle.set(`${row.category} | ${row.title}`, (byTitle.get(`${row.category} | ${row.title}`) ?? 0) + 1);
      continue;
    }
    const openable = normalizeOpenableLog(row.title, data);
    if (openable) {
      stats.recognized += 1;
      candidates.push({ userId: row.userId, sourceRef: row.sourceRef, occurredAt: row.occurredAt, title: row.title, category: row.category, data, domain: "openable" });
      continue;
    }
    stats.ambiguous += 1;
    byTitle.set(`${row.category} | ${row.title}`, (byTitle.get(`${row.category} | ${row.title}`) ?? 0) + 1);
  }

  console.log(`Candidate raw logs: ${rows.length}`);
  console.log(`Recognized (would insert): ${stats.recognized}`);
  console.log(`Unsupported (casino-routed, no payload semantics): ${stats.unsupported}`);
  console.log(`Ambiguous: ${stats.ambiguous}`);
  for (const [key, count] of [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(count).padStart(6)}  ${key}`);
  }

  if (candidates.length === 0) {
    console.log("Nothing to repair.");
    return;
  }
  if (dryRun) {
    console.log("DRY RUN — nothing was changed. Re-run without --dry-run to apply.");
    return;
  }

  const inserts: Array<Record<string, unknown>> = [];
  for (const c of candidates) {
    if (c.domain === "casino") {
      const casino = normalizeCasino(c.category, c.title, c.data);
      if (!casino) continue;
      const netValue =
        casino.outcome === "placed"
          ? null
          : casino.cashReward !== null && casino.cashInput !== null
            ? casino.cashReward - casino.cashInput
            : casino.cashReward !== null
              ? casino.cashReward
              : casino.cashInput !== null
                ? -casino.cashInput
                : null;
      inserts.push({
        userId: c.userId,
        occurredAt: c.occurredAt,
        domain: "casino",
        activityType: casino.activityType,
        activityLabel: casino.activityLabel,
        subtype: casino.subtype,
        outcome: casino.outcome,
        game: casino.game,
        wheel: casino.wheel,
        cashInput: casino.cashInput,
        cashReward: casino.cashReward,
        pointsReward: casino.pointsReward,
        tokensReward: casino.tokensReward,
        netValue,
        valuation: "exact",
        provenance: "exact",
        source: "torn_log",
        sourceRef: c.sourceRef,
        metadata: c.data,
      });
      continue;
    }
    const openable = normalizeOpenableLog(c.title, c.data);
    if (!openable) continue;
    inserts.push({
      userId: c.userId,
      occurredAt: c.occurredAt,
      domain: "openable",
      activityType: openable.activityType,
      activityLabel: openable.activityLabel,
      subtype: "opened",
      outcome: "opened",
      cashReward: openable.cashReward,
      pointsReward: openable.pointsReward,
      netValue: openable.cashReward,
      valuation: openable.cashReward !== null ? "exact" : "unpriced",
      provenance: "exact",
      source: "torn_log",
      sourceRef: c.sourceRef,
      metadata: c.data,
    });
  }

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const result = await db.activityEvent.createMany({ data: inserts.slice(i, i + BATCH) as never[], skipDuplicates: true });
    inserted += result.count;
  }
  console.log(`Repair applied: ${inserted} ActivityEvent rows inserted (skipDuplicates; raw archive untouched).`);
  console.log("Re-run — it must now report 0 candidates.");

  // Money reconciliation diagnostic: casino activity cash delta vs ledger
  // casino delta. Differences are REPORTED, never patched.
  const casinoMoney = await db.$queryRawUnsafe<Array<{ user_id: string; activity_cash: string }>>(`
    SELECT "userId" AS user_id, sum(COALESCE("cashReward",0) - COALESCE("cashInput",0))::text AS activity_cash
    FROM "ActivityEvent" WHERE domain = 'casino' GROUP BY "userId"
  `);
  const ledgerMoney = await db.$queryRawUnsafe<Array<{ user_id: string; ledger_cash: string }>>(`
    SELECT "userId" AS user_id, sum(CASE WHEN direction='income' THEN amount ELSE -amount END)::text AS ledger_cash
    FROM "MoneyEvent" WHERE category = 'casino' GROUP BY "userId"
  `);
  const ledgerByUser = new Map(ledgerMoney.map((r) => [r.user_id, BigInt(r.ledger_cash)]));
  console.log("\nMoney reconciliation (casino): activity cash delta vs ledger casino delta");
  for (const row of casinoMoney) {
    const activity = BigInt(row.activity_cash);
    const ledger = ledgerByUser.get(row.user_id) ?? 0n;
    const diff = activity - ledger;
    console.log(`  user ${row.user_id}: activity=${activity} ledger=${ledger} diff=${diff}${diff !== 0n ? " (known ledger gap: slots/bookie/blackjack/high-low/keno bet keys are not money-key-covered — see docs/ACTIVITY-REWARDS.md)" : ""}`);
  }
}

main().catch((err) => {
  console.error("repair failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
