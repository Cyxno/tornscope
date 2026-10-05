import { getPrismaClient } from "../client.js";
import { normalizeCasinoLog } from "../normalizers/casino.js";
import { normalizeOpenableLog } from "../normalizers/openables.js";
import { routeLog } from "../normalizers/titles.js";
import type { LogRecord } from "../normalizers/extract.js";

/**
 * Raw-event utilization audit (2.4.0) — operator/developer diagnostic over
 * the locally stored archive. Zero upstream calls; two bounded scans.
 *
 *   pnpm --filter @tornscope/database audit:activities
 *
 * Reports, per distinct (category, title) raw log family and in aggregate:
 * - raw families: every distinct log family in TimelineEvent (type=log)
 * - recognized families: claimed by ANY normalizer domain (money, drugs,
 *   rehab, travel, consumption, crimes, casino, openable) — decided by the
 *   current normalizers against a per-family sample payload
 * - normalized families: families that actually produced semantic rows
 *   (ActivityEvent, plus MoneyEvent as the ledger view)
 * - analytics-used families: ActivityEvent families carrying at least one
 *   reportable component (cash/points/tokens/net or reward items)
 * - unclassified value-bearing families: no normalizer claims them while
 *   their sample payload carries value-shaped keys — the actionable gap
 *   list for future coverage, grouped by category/title with counts.
 *
 * Also prints the casino money reconciliation (semantic activity cash delta
 * vs MoneyEvent ledger delta). Differences are surfaced, never patched.
 */

/** Payload keys that indicate a potential money/reward value. */
const VALUE_KEYS = [
  "money", "amount", "bet", "bet_amount", "winnings", "cost", "won_amount",
  "losses", "points", "items", "item2", "casino_tokens_increased",
] as const;

interface FamilyRow {
  category: string;
  title: string;
  count: bigint;
  sample: unknown;
}

interface NormalizedFamilyRow {
  domain: string;
  activityType: string;
  count: bigint;
  withComponents: bigint;
}

function payloadOf(sample: unknown): LogRecord {
  return (sample as { data?: Record<string, unknown> } | null)?.data ?? {};
}

function isValueBearing(data: LogRecord): boolean {
  return VALUE_KEYS.some((k) => data[k] !== undefined);
}

/** Does any normalizer claim this family? Decided on the sample payload. */
function isRecognized(category: string, title: string, data: LogRecord): boolean {
  if (routeLog(category, title) !== "timeline") return true;
  if (normalizeCasinoLog(category, title, data)) return true;
  if (normalizeOpenableLog(title, data)) return true;
  return false;
}

export function analyzeFamily(category: string, title: string, sample: unknown): {
  route: string; recognized: boolean; valueBearing: boolean;
} {
  const data = payloadOf(sample);
  return {
    route: routeLog(category, title),
    recognized: isRecognized(category, title, data),
    valueBearing: isValueBearing(data),
  };
}

async function main(): Promise<void> {
  const db = getPrismaClient();

  // One grouped scan for families + one DISTINCT ON scan for per-family
  // sample payloads. Both bounded by the archive itself (read-only).
  const [familyCounts, samples, normalized, ledger] = await Promise.all([
    db.$queryRawUnsafe<Array<{ category: string; title: string; count: bigint }>>(
      `SELECT "category", "title", count(*)::bigint AS count
       FROM "TimelineEvent" WHERE "type" = 'log'
       GROUP BY 1, 2`,
    ),
    db.$queryRawUnsafe<FamilyRow[]>(
      `SELECT DISTINCT ON ("category", "title") "category", "title", "metadata" AS sample
       FROM "TimelineEvent" WHERE "type" = 'log'
       ORDER BY "category", "title", "occurredAt" DESC`,
    ),
    db.$queryRawUnsafe<NormalizedFamilyRow[]>(
      `SELECT domain, "activityType", count(*)::bigint AS count,
              count(*) FILTER (WHERE "cashReward" IS NOT NULL OR "cashInput" IS NOT NULL
                                  OR "pointsReward" IS NOT NULL OR "tokensReward" IS NOT NULL
                                  OR "netValue" IS NOT NULL OR metadata ? 'items'
                                  OR metadata ? 'item2')::bigint AS "withComponents"
       FROM "ActivityEvent" GROUP BY 1, 2`,
    ),
    db.$queryRawUnsafe<Array<{ category: string; families: bigint; count: bigint }>>(
      `SELECT "category", count(DISTINCT "subcategory")::bigint AS families, count(*)::bigint AS count
       FROM "MoneyEvent" GROUP BY 1`,
    ),
  ]);

  const sampleByFamily = new Map(samples.map((s) => [`${s.category} | ${s.title}`, s.sample]));

  let rawEvents = 0n;
  let recognizedFamilies = 0;
  let recognizedEvents = 0n;
  const unclassified: Array<{ family: string; count: bigint; route: string }> = [];
  const routeTotals = new Map<string, bigint>();
  for (const f of familyCounts) {
    rawEvents += f.count;
    const a = analyzeFamily(f.category, f.title, sampleByFamily.get(`${f.category} | ${f.title}`) ?? null);
    routeTotals.set(a.route, (routeTotals.get(a.route) ?? 0n) + f.count);
    if (a.recognized) {
      recognizedFamilies += 1;
      recognizedEvents += f.count;
    } else if (a.valueBearing) {
      unclassified.push({ family: `${f.category} | ${f.title}`, count: f.count, route: a.route });
    }
  }

  let normalizedFamilies = 0;
  let analyticsUsedFamilies = 0;
  let normalizedRows = 0n;
  for (const n of normalized) {
    normalizedFamilies += 1;
    normalizedRows += n.count;
    if (n.withComponents > 0n) analyticsUsedFamilies += 1;
  }

  console.log("=== Raw event utilization (2.4.0 diagnostic) ===");
  console.log(`raw log families:            ${familyCounts.length} (${rawEvents} events)`);
  console.log(`recognized families/events:  ${recognizedFamilies} families — ${recognizedEvents} events claimed by a normalizer domain`);
  console.log(`normalized families:         ${normalizedFamilies} ActivityEvent families (${normalizedRows} rows) + ${ledger.length} MoneyEvent categories`);
  console.log(`analytics-used families:     ${analyticsUsedFamilies} ActivityEvent families carry reportable components`);
  console.log(`unclassified value-bearing:  ${unclassified.length} families`);
  const sorted = [...routeTotals.entries()].sort((a, b) => Number(b[1]) - Number(a[1]));
  console.log("\nEvents by routed domain:");
  for (const [route, n] of sorted) console.log(`  ${route.padEnd(10)} ${n}`);
  if (unclassified.length > 0) {
    console.log("\nUnclassified value-bearing families (payload has value keys, no normalizer claims):");
    for (const u of unclassified.sort((a, b) => Number(b.count) - Number(a.count)).slice(0, 25)) {
      console.log(`  ${String(u.count).padStart(8)}  ${u.family}`);
    }
    if (unclassified.length > 25) console.log(`  … ${unclassified.length - 25} more`);
  } else {
    console.log("\nUnclassified value-bearing families: none — every value-shaped log family is claimed.");
  }

  // Casino reconciliation: semantic activity cash delta vs ledger delta.
  const casinoActivity = await db.$queryRawUnsafe<Array<{ user_id: string; activity_cash: string }>>(
    `SELECT "userId" AS user_id, sum(COALESCE("cashReward",0) - COALESCE("cashInput",0))::text AS activity_cash
     FROM "ActivityEvent" WHERE domain = 'casino' GROUP BY 1`,
  );
  const casinoLedger = await db.$queryRawUnsafe<Array<{ user_id: string; ledger_cash: string }>>(
    `SELECT "userId" AS user_id, sum(CASE WHEN direction='income' THEN amount ELSE -amount END)::text AS ledger_cash
     FROM "MoneyEvent" WHERE category = 'casino' GROUP BY 1`,
  );
  const ledgerByUser = new Map(casinoLedger.map((r) => [r.user_id, BigInt(r.ledger_cash)]));
  console.log("\nCasino reconciliation (semantic activity cash vs MoneyEvent ledger):");
  if (casinoActivity.length === 0) console.log("  no casino activity normalized yet");
  for (const row of casinoActivity) {
    const activity = BigInt(row.activity_cash);
    const ledgerCash = ledgerByUser.get(row.user_id) ?? 0n;
    const diff = activity - ledgerCash;
    console.log(`  user ${row.user_id}: activity=${activity} ledger=${ledgerCash} diff=${diff}${diff !== 0n ? " (surfaced, not patched — see docs/ACTIVITY-REWARDS.md)" : ""}`);
  }
}

main().catch((err) => {
  console.error("activity utilization audit failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
