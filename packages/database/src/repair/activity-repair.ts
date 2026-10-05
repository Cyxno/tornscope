import { getPrismaClient } from "../client.js";
import { normalizeCasinoLog as normalizeCasino } from "../normalizers/casino.js";
import { normalizeOpenableLog } from "../normalizers/openables.js";
import { buildDomainMetadata, normalizeDomainLog } from "../normalizers/domains.js";
import { routeLog } from "../normalizers/titles.js";

/**
 * Activity & Rewards repair (2.5.0) — backfill ActivityEvents from the raw
 * TimelineEvent archive using the current normalizers.
 *
 *   pnpm --filter @tornscope/database repair:activities [--dry-run]
 *
 * Idempotent via (userId, source, sourceRef) unique; raw archive untouched;
 * dry-run prints candidate/recognized/unsupported counts first. Also prints
 * money-reconciliation diagnostics for every domain that carries exact cash
 * — differences are reported, never patched.
 *
 * 2.5.0 additions:
 * - hunting / missions / racing / bounties / education domain families.
 * - Legacy casino money logs (old-format rows whose only value is the
 *   TimelineEvent.amount column — no structured payload, no game
 *   attribution): normalized as unattributed legacy casino income so the
 *   semantic view converges with the ledger instead of leaving 400+ value
 *   rows unexplained. The game is UNKNOWN and stays unknown — never guessed.
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
  /** Structured payload when the row carries one; empty for legacy rows. */
  data: Record<string, unknown>;
  /** TimelineEvent.amount column (legacy money logs carry only this). */
  amount: bigint | null;
  kind: "casino" | "openable" | "domain" | "casino-legacy";
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv);
  const db = getPrismaClient();

  // Candidate rows: raw logs one of the normalizers may claim that do not
  // yet have an ActivityEvent with the same sourceRef. The SQL is a
  // deliberate SUPERSET of normalizer claims; recognition is decided by the
  // normalizers and the rest lands in unsupported/ambiguous — the
  // unrecognized-value diagnostic.
  const rows = await db.$queryRawUnsafe<Array<{
    userId: string; sourceRef: string; occurredAt: Date; category: string; title: string; metadata: unknown; amount: string | null;
  }>>(`
    SELECT te."userId", te."sourceRef", te."occurredAt", te."category", te."title", te."metadata", te."amount"::text AS amount
    FROM "TimelineEvent" te
    WHERE te."type" = 'log'
      AND (
        te."category" ILIKE '%casino%'
        OR te."category" ILIKE '%hunting%'
        OR te."category" ILIKE '%missions%'
        OR te."category" ILIKE '%racing%'
        OR te."category" ILIKE '%bounties%'
        OR te."category" ILIKE '%education%'
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
  const bump = (key: string) => byTitle.set(key, (byTitle.get(key) ?? 0) + 1);

  for (const row of rows) {
    const data = (row.metadata as { data?: Record<string, unknown> } | null)?.data ?? {};
    const amount = row.amount !== null ? BigInt(row.amount) : null;

    if (routeLog(row.category, row.title) === "casino") {
      const casino = normalizeCasino(row.category, row.title, data);
      if (casino) {
        stats.recognized += 1;
        candidates.push({ userId: row.userId, sourceRef: row.sourceRef, occurredAt: row.occurredAt, title: row.title, category: row.category, data, amount, kind: "casino" });
        continue;
      }
      // Legacy money-format casino logs: no structured payload, only the
      // signed amount column. Income amounts are casino payouts of unknown
      // game; negative amounts are unattributed stakes. Only claimed when
      // the payload is genuinely absent — a structured payload with
      // different semantics must never fall in here.
      if (amount !== null && amount !== 0n && Object.keys(data).length === 0) {
        stats.recognized += 1;
        candidates.push({ userId: row.userId, sourceRef: row.sourceRef, occurredAt: row.occurredAt, title: row.title, category: row.category, data, amount, kind: "casino-legacy" });
        continue;
      }
      stats.unsupported += 1;
      bump(`${row.category} | ${row.title}`);
      continue;
    }

    const route = routeLog(row.category, row.title);
    if (route === "hunting" || route === "missions" || route === "racing" || route === "bounties" || route === "education") {
      const domain = normalizeDomainLog(row.category, row.title, data);
      if (domain) {
        stats.recognized += 1;
        candidates.push({ userId: row.userId, sourceRef: row.sourceRef, occurredAt: row.occurredAt, title: row.title, category: row.category, data, amount, kind: "domain" });
        continue;
      }
      // Domain-category rows the normalizer does not claim stay
      // unrecognized-but-visible in the gap list (never dropped, never guessed).
      stats.ambiguous += 1;
      bump(`${row.category} | ${row.title}`);
      continue;
    }

    if (route !== "timeline") {
      // Openable item-use candidates.
      const openable = normalizeOpenableLog(row.title, data);
      if (openable) {
        stats.recognized += 1;
        candidates.push({ userId: row.userId, sourceRef: row.sourceRef, occurredAt: row.occurredAt, title: row.title, category: row.category, data, amount, kind: "openable" });
        continue;
      }
      stats.ambiguous += 1;
      bump(`${row.category} | ${row.title}`);
      continue;
    }

    // Timeline-routed rows can only be casino candidates misrouted here —
    // keep them visible rather than silently dropped.
    stats.ambiguous += 1;
    bump(`${row.category} | ${row.title}`);
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
    if (c.kind === "casino") {
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
    if (c.kind === "casino-legacy") {
      const amount = c.amount!; // legacy candidates are only built with a non-null amount
      const isIncome = amount > 0n;
      inserts.push({
        userId: c.userId,
        occurredAt: c.occurredAt,
        domain: "casino",
        activityType: "casino-legacy",
        activityLabel: "Casino (legacy)",
        subtype: isIncome ? "win" : "stake",
        outcome: isIncome ? "win" : "loss",
        game: null, // old-format logs carry no game attribution — stays unknown
        wheel: null,
        cashInput: isIncome ? null : -amount,
        cashReward: isIncome ? amount : null,
        pointsReward: null,
        tokensReward: null,
        netValue: amount,
        valuation: "exact",
        provenance: "exact",
        source: "torn_log",
        sourceRef: c.sourceRef,
        metadata: { legacy: true, title: c.title, category: c.category },
      });
      continue;
    }
    if (c.kind === "openable") {
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
      continue;
    }
    const domain = normalizeDomainLog(c.category, c.title, c.data);
    if (!domain) continue;
    inserts.push({
      userId: c.userId,
      occurredAt: c.occurredAt,
      domain: domain.domain,
      activityType: domain.activityType,
      activityLabel: domain.activityLabel,
      subtype: domain.subtype,
      outcome: domain.outcome,
      game: null,
      wheel: null,
      opponentId: domain.opponentId,
      cashInput: domain.cashInput,
      cashReward: domain.cashReward,
      pointsReward: domain.pointsReward,
      tokensReward: domain.tokensReward,
      netValue: domain.netValue,
      valuation: domain.valuation,
      provenance: domain.provenance,
      source: "torn_log",
      sourceRef: c.sourceRef,
      metadata: buildDomainMetadata(c.category, c.title, c.data),
    });
  }

  const BATCH = 500;
  let inserted = 0;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const result = await db.activityEvent.createMany({ data: inserts.slice(i, i + BATCH) as never[], skipDuplicates: true });
    inserted += result.count;
  }
  console.log(`Repair applied: ${inserted} ActivityEvent rows inserted (skipDuplicates; raw archive untouched).`);
  console.log("Re-run — it must now report 0 new recognized rows.");

  await printReconciliation(db);
}

/** Money reconciliation (2.5.0): semantic ActivityEvent cash delta vs the
 *  MoneyEvent ledger, per user and domain. MoneyEvent.amount is SIGNED —
 *  summed directly. Casino games whose cash never appears in money logs
 *  (slots/keno/blackjack/high-low/bookie) are a KNOWN structural ledger
 *  gap, disclosed — never patched. */
async function printReconciliation(db: ReturnType<typeof getPrismaClient>): Promise<void> {
  const activity = await db.$queryRawUnsafe<Array<{ user_id: string; domain: string; activity_cash: string }>>(
    `SELECT "userId" AS user_id, domain, sum(COALESCE("cashReward",0) - COALESCE("cashInput",0))::text AS activity_cash
     FROM "ActivityEvent" WHERE "cashReward" IS NOT NULL OR "cashInput" IS NOT NULL
     GROUP BY 1, 2`,
  );
  const ledger = await db.$queryRawUnsafe<Array<{ user_id: string; category: string; ledger_cash: string }>>(
    `SELECT "userId" AS user_id, category, sum(amount)::text AS ledger_cash
     FROM "MoneyEvent" GROUP BY 1, 2`,
  );
  const ledgerByUserCategory = new Map(ledger.map((r) => [`${r.user_id}|${r.category}`, BigInt(r.ledger_cash)]));
  // Domain → the ledger category that should carry its cash (only casino has
  // a real mapping; hunting/missions/racing/bounties/education cash is
  // semantic-only by construction).
  const ledgerCategoryByDomain: Record<string, string> = { casino: "casino" };

  console.log("\nMoney reconciliation (semantic activity cash vs MoneyEvent ledger, signed):");
  const byUserDomain = new Map<string, bigint>();
  for (const row of activity) byUserDomain.set(`${row.user_id}|${row.domain}`, BigInt(row.activity_cash));
  for (const [key, activityCash] of [...byUserDomain.entries()].sort()) {
    const [userId, domain] = key.split("|");
    const ledgerCategory = ledgerCategoryByDomain[domain!];
    if (!ledgerCategory) {
      console.log(`  user ${userId} ${domain}: activity=${activityCash} ledger=n/a (semantic-only domain — Torn emits no money logs for it)`);
      continue;
    }
    const ledgerCash = ledgerByUserCategory.get(`${userId}|${ledgerCategory}`) ?? 0n;
    const diff = activityCash - ledgerCash;
    console.log(`  user ${userId} ${domain}: activity=${activityCash} ledger=${ledgerCash} diff=${diff}${diff !== 0n ? " (surfaced, not patched — known structural ledger gaps: slots/keno/blackjack/high-low/bookie + pending placements)" : ""}`);
  }
}

main().catch((err) => {
  console.error("repair failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
