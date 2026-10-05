import { getPrismaClient } from "../client.js";
import { normalizeCasinoLog } from "../normalizers/casino.js";
import { normalizeOpenableLog } from "../normalizers/openables.js";
import { normalizeDomainLog } from "../normalizers/domains.js";
import { aggregateCasinoEconomics, type CasinoEconomicsRow } from "../normalizers/casino-economics.js";
import { routeLog } from "../normalizers/titles.js";
import type { LogRecord } from "../normalizers/extract.js";

/**
 * Raw-event utilization audit 2.1 (2.5.1) — operator/developer diagnostic
 * over the locally stored archive. Zero upstream calls; read-only.
 *
 *   pnpm --filter @tornscope/database audit:activities [--matrix] [--json]
 *
 * 2.5.1: recognition is decided per PAYLOAD SHAPE, not per family. A
 * single (category, title) family can carry heterogeneous payload shapes
 * (log formats evolve); one representative sample per family can therefore
 * claim a family whose other shapes normalize to nothing — or vice versa.
 * Shapes are fingerprinted in SQL (sorted data keys + JSON types — never
 * values), and every distinct shape gets its own normalizer verdict:
 *
 * - family recognized = ALL observed shapes claimed (strict)
 * - family PARTIAL = some shapes claimed, others not
 * - unrecognized value-bearing SHAPES are the actionable gap list
 *
 * Coverage is reported at family AND shape AND event level — never mixed.
 *
 * Also prints the casino reconciliation decomposed into semantic
 * wagered/returned/net/withdrawals/pending (logical-play ownership) vs
 * ledger income/expense/net — so a difference can be EXPLAINED, not just
 * observed. Never auto-patched.
 */

/** Payload keys that indicate a potential economic value. Diagnostic
 *  candidate detection ONLY — presence never confers semantics. */
const VALUE_KEYS = [
  "money", "amount", "cost", "price", "fee", "fees", "reward", "rewards",
  "value", "points", "tokens", "credits", "bet", "bet_amount", "winnings",
  "won_amount", "losses", "item", "items", "item2", "quantity", "qty",
  "received", "spent", "earned", "paid", "withdrawn", "deposited",
  "income", "bounty_reward", "casino_tokens_increased",
] as const;

interface ShapeRow {
  category: string;
  title: string;
  shape: string | null;
  count: bigint;
  oldest: Date;
  newest: Date;
  sample: unknown;
}

type FamilyClass = "A" | "B" | "C" | "D" | "E" | "F";

interface ShapeAnalysis {
  category: string;
  title: string;
  shape: string | null;
  count: bigint;
  claimed: boolean;
  valueBearing: boolean;
}

interface FamilyAnalysis {
  category: string;
  title: string;
  count: bigint;
  oldest: Date;
  newest: Date;
  route: string;
  shapes: number;
  recognizedShapes: number;
  /** every observed shape claimed by a normalizer (strict recognition) */
  recognized: boolean;
  /** some shapes claimed, others not */
  partial: boolean;
  normalized: boolean;
  analyticsUsed: boolean;
  valueBearing: boolean;
  familyClass: FamilyClass;
}

function payloadOf(sample: unknown): LogRecord {
  return (sample as { data?: Record<string, unknown> } | null)?.data ?? {};
}

function isValueBearing(data: LogRecord): boolean {
  return VALUE_KEYS.some((k) => data[k] !== undefined);
}

/** Does any activity-layer normalizer claim this shape? Specialist routes
 *  (money, drugs, travel, rehab, itemuse, crimes) claim by route — each has
 *  a dedicated table filled by the same sync and a consuming surface. */
function shapeClaimed(category: string, title: string, data: LogRecord): boolean {
  if (normalizeCasinoLog(category, title, data)) return true;
  if (normalizeOpenableLog(title, data)) return true;
  if (normalizeDomainLog(category, title, data)) return true;
  return false;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

interface UtilizationReport {
  raw: { families: number; shapes: number; events: number };
  normalization: { fullyCoveredFamilies: number; partiallyCoveredFamilies: number; unrecognizedShapes: number };
  valueCoverage: {
    valueBearingShapes: number; valueBearingEvents: string;
    recognizedValueShapes: number; recognizedValueEvents: string;
    uncoveredValueShapes: number; uncoveredValueEvents: string;
  };
  activity: { rows: number; reportableRows: number; semanticFamilies: number };
  classes: Record<FamilyClass, { families: number; events: string }>;
  families: Array<{
    category: string; title: string; count: string; shapes: number; recognizedShapes: number;
    route: string; recognized: boolean; partial: boolean; normalized: boolean;
    analyticsUsed: boolean; valueBearing: boolean; familyClass: FamilyClass; oldest: string; newest: string;
  }>;
  reconciliation: Array<{
    userId: string; semanticWagered: string; semanticReturned: string; semanticNet: string;
    withdrawals: string; pending: number; ledgerIncome: string; ledgerExpense: string; ledgerNet: string; difference: string;
  }>;
}

async function main(): Promise<void> {
  const showMatrix = process.argv.includes("--matrix");
  const jsonOutput = process.argv.includes("--json");
  const db = getPrismaClient();

  // One grouped scan for family+shape counts, one DISTINCT ON scan for a
  // sample per shape, plus semantic-row rollups. All read-only; grouping
  // happens in Postgres (no 50k-row Node deserialization).
  const [shapeRows, samples, activityByFamily, activityTotals, ledgerDescriptions, ledgerByUserCategory, casinoByUser] = await Promise.all([
    db.$queryRawUnsafe<Array<{ category: string; title: string; shape: string | null; count: bigint; oldest: Date; newest: Date }>>(
      `SELECT "category", "title",
              (SELECT string_agg(ks.k || ':' || jsonb_typeof(ks.v), '|' ORDER BY ks.k)
                 FROM jsonb_each(COALESCE(te.metadata->'data', '{}'::jsonb)) AS ks(k, v)) AS shape,
              count(*)::bigint AS count,
              min("occurredAt") AS oldest, max("occurredAt") AS newest
       FROM "TimelineEvent" te
       WHERE te."type" = 'log'
       GROUP BY 1, 2, 3`,
    ),
    db.$queryRawUnsafe<ShapeRow[]>(
      `SELECT DISTINCT ON ("category", "title", shape)
              "category", "title", shape, "metadata" AS sample,
              count(*) OVER (PARTITION BY "category", "title", shape) AS count,
              min("occurredAt") OVER (PARTITION BY "category", "title", shape) AS oldest,
              max("occurredAt") OVER (PARTITION BY "category", "title", shape) AS newest
       FROM (
         SELECT te."category", te."title", te."metadata", te."occurredAt",
                (SELECT string_agg(ks.k || ':' || jsonb_typeof(ks.v), '|' ORDER BY ks.k)
                   FROM jsonb_each(COALESCE(te.metadata->'data', '{}'::jsonb)) AS ks(k, v)) AS shape
         FROM "TimelineEvent" te
         WHERE te."type" = 'log'
       ) s
       ORDER BY "category", "title", shape, "occurredAt" DESC`,
    ),
    db.$queryRawUnsafe<Array<{ domain: string; activityType: string; count: bigint; withComponents: bigint }>>(
      `SELECT domain, "activityType", count(*)::bigint AS count,
              count(*) FILTER (WHERE "cashReward" IS NOT NULL OR "cashInput" IS NOT NULL
                                  OR "pointsReward" IS NOT NULL OR "tokensReward" IS NOT NULL
                                  OR "netValue" IS NOT NULL OR metadata ? 'items'
                                  OR metadata ? 'item2')::bigint AS "withComponents"
       FROM "ActivityEvent" GROUP BY 1, 2`,
    ),
    db.$queryRawUnsafe<Array<{ rows: bigint; reportable: bigint }>>(
      `SELECT count(*)::bigint AS rows,
              count(*) FILTER (WHERE "cashReward" IS NOT NULL OR "cashInput" IS NOT NULL
                                  OR "pointsReward" IS NOT NULL OR "tokensReward" IS NOT NULL
                                  OR "netValue" IS NOT NULL OR metadata ? 'items'
                                  OR metadata ? 'item2')::bigint AS reportable
       FROM "ActivityEvent"`,
    ),
    db.$queryRawUnsafe<Array<{ description: string }>>(
      // MoneyEvent.description stores the raw log title — exact family link.
      `SELECT DISTINCT "description" FROM "MoneyEvent" WHERE "description" IS NOT NULL AND "description" <> ''`,
    ),
    db.$queryRawUnsafe<Array<{ user_id: string; income: string; expense: string; net: string }>>(
      // MoneyEvent.amount is SIGNED (expenses negative) — summed directly.
      `SELECT "userId" AS user_id,
              sum(amount) FILTER (WHERE amount > 0)::text AS income,
              sum(amount) FILTER (WHERE amount < 0)::text AS expense,
              sum(amount)::text AS net
       FROM "MoneyEvent" WHERE category = 'casino' GROUP BY 1`,
    ),
    db.$queryRawUnsafe<Array<{ user_id: string; activityType: string; subtype: string | null; outcome: string | null; cash_input: string | null; cash_reward: string | null; net_value: string | null }>>(
      `SELECT "userId" AS user_id, "activityType", subtype, outcome,
              "cashInput"::text AS cash_input, "cashReward"::text AS cash_reward, "netValue"::text AS net_value
       FROM "ActivityEvent" WHERE domain = 'casino'`,
    ),
  ]);

  const sampleByShape = new Map(samples.map((s) => [`${s.category}|${s.title}|${s.shape ?? ""}`, s.sample]));
  const ledgerTitleSet = new Set(ledgerDescriptions.map((r) => r.description));
  const activityKeyByType = new Map(activityByFamily.map((r) => [r.activityType, r]));

  // Per-shape recognition (the 2.5.1 core change).
  const shapes: ShapeAnalysis[] = shapeRows.map((sr) => {
    const sample = sampleByShape.get(`${sr.category}|${sr.title}|${sr.shape ?? ""}`);
    const data = payloadOf(sample);
    const route = routeLog(sr.category, sr.title);
    const specialist = ["crimes", "drugs", "rehab", "travel", "itemuse", "money"].includes(route);
    return {
      category: sr.category,
      title: sr.title,
      shape: sr.shape,
      count: sr.count,
      claimed: specialist || shapeClaimed(sr.category, sr.title, data),
      valueBearing: isValueBearing(data),
    };
  });

  // Family rollup over shapes (strict recognition).
  const familyMap = new Map<string, { category: string; title: string; count: bigint; oldest: Date; newest: Date; shapes: ShapeAnalysis[] }>();
  for (const sr of shapeRows) {
    const key = `${sr.category}|${sr.title}`;
    const entry = familyMap.get(key) ?? {
      category: sr.category, title: sr.title, count: 0n, oldest: sr.oldest, newest: sr.newest, shapes: [],
    };
    entry.count += sr.count;
    if (sr.oldest < entry.oldest) entry.oldest = sr.oldest;
    if (sr.newest > entry.newest) entry.newest = sr.newest;
    const shapeAnalysis = shapes.find((s) => s.category === sr.category && s.title === sr.title && s.shape === sr.shape);
    if (shapeAnalysis && !entry.shapes.includes(shapeAnalysis)) entry.shapes.push(shapeAnalysis);
    familyMap.set(key, entry);
  }

  const analyses: FamilyAnalysis[] = [];
  for (const f of familyMap.values()) {
    const data = payloadOf(sampleByShape.get(`${f.category}|${f.title}|${f.shapes[0]?.shape ?? ""}`));
    const domainType = normalizerFamilyKey(f.category, f.title, data);
    const activityRow = domainType ? activityKeyByType.get(domainType) : undefined;
    const route = routeLog(f.category, f.title);
    const hasLedgerRows = route === "money" ? ledgerTitleSet.has(f.title) : false;
    const specialistRoute = ["drugs", "rehab", "travel", "itemuse", "crimes", "money"].includes(route);
    const recognizedShapes = f.shapes.filter((s) => s.claimed).length;
    const recognized = recognizedShapes === f.shapes.length && f.shapes.length > 0;
    const partial = recognizedShapes > 0 && recognizedShapes < f.shapes.length;
    const normalized = Boolean(activityRow && activityRow.count > 0n) || hasLedgerRows || specialistRoute;
    // Specialist-route families feed dedicated analytics surfaces — used by
    // definition; activity-layer usage comes from component presence.
    const analyticsUsed = specialistRoute || Boolean(activityRow && activityRow.withComponents > 0n);
    const valueBearing = f.shapes.some((s) => s.valueBearing);

    let familyClass: FamilyClass;
    if (recognized && normalized && analyticsUsed) familyClass = "A";
    else if (recognized && normalized) familyClass = "B";
    else if (recognized) familyClass = "C";
    else if (partial) familyClass = "F";
    else if (valueBearing) familyClass = "D";
    else familyClass = "E";

    analyses.push({
      category: f.category, title: f.title, count: f.count, oldest: f.oldest, newest: f.newest,
      route, shapes: f.shapes.length, recognizedShapes, recognized, partial,
      normalized, analyticsUsed, valueBearing, familyClass,
    });
  }

  // ----- aggregate report numbers -----
  const totalFamilies = analyses.length;
  const totalShapes = shapes.length;
  const totalEvents = analyses.reduce((acc, a) => acc + a.count, 0n);
  const byClass = (cls: FamilyClass) => analyses.filter((a) => a.familyClass === cls);
  const eventsOf = (list: Array<{ count: bigint }>) => list.reduce((acc, a) => acc + a.count, 0n);
  const recognizedList = analyses.filter((a) => a.recognized);
  const partialList = analyses.filter((a) => a.partial);
  const valueShapes = shapes.filter((s) => s.valueBearing);
  const valueShapesRecognized = valueShapes.filter((s) => s.claimed);
  const valueShapesUncovered = valueShapes.filter((s) => !s.claimed);

  // ----- casino reconciliation, decomposed (logical-play ownership) -----
  const reconRows: UtilizationReport["reconciliation"] = [];
  const casinoRowsByUser = new Map<string, CasinoEconomicsRow[]>();
  for (const r of casinoByUser) {
    const list = casinoRowsByUser.get(r.user_id) ?? [];
    list.push({
      activityType: r.activityType, subtype: r.subtype, outcome: r.outcome,
      cashInput: r.cash_input === null ? null : BigInt(r.cash_input),
      cashReward: r.cash_reward === null ? null : BigInt(r.cash_reward),
      netValue: r.net_value === null ? null : BigInt(r.net_value),
    });
    casinoRowsByUser.set(r.user_id, list);
  }
  for (const [userId, rows] of [...casinoRowsByUser.entries()].sort()) {
    const eco = aggregateCasinoEconomics(rows);
    const ledger = ledgerByUserCategory.find((l) => l.user_id === userId);
    const ledgerIncome = BigInt(ledger?.income ?? 0);
    const ledgerExpense = BigInt(ledger?.expense ?? 0);
    const ledgerNet = ledger ? BigInt(ledger.net) : null;
    reconRows.push({
      userId,
      semanticWagered: eco.wagered.toString(),
      semanticReturned: eco.returned.toString(),
      semanticNet: (eco.net ?? 0n).toString(),
      withdrawals: eco.withdrawn.toString(),
      pending: eco.pending,
      ledgerIncome: ledgerIncome.toString(),
      ledgerExpense: ledgerExpense.toString(),
      ledgerNet: (ledgerNet ?? 0n).toString(),
      difference: eco.net !== null && ledgerNet !== null ? (eco.net - ledgerNet).toString() : "n/a",
    });
  }

  const report: UtilizationReport = {
    raw: { families: totalFamilies, shapes: totalShapes, events: Number(totalEvents) },
    normalization: {
      fullyCoveredFamilies: recognizedList.length,
      partiallyCoveredFamilies: partialList.length,
      unrecognizedShapes: shapes.filter((s) => !s.claimed).length,
    },
    valueCoverage: {
      valueBearingShapes: valueShapes.length,
      valueBearingEvents: eventsOf(valueShapes).toString(),
      recognizedValueShapes: valueShapesRecognized.length,
      recognizedValueEvents: eventsOf(valueShapesRecognized).toString(),
      uncoveredValueShapes: valueShapesUncovered.length,
      uncoveredValueEvents: eventsOf(valueShapesUncovered).toString(),
    },
    activity: {
      rows: Number(activityTotals[0]?.rows ?? 0n),
      reportableRows: Number(activityTotals[0]?.reportable ?? 0n),
      semanticFamilies: activityByFamily.length,
    },
    classes: Object.fromEntries((["A", "B", "C", "D", "E", "F"] as FamilyClass[]).map((cls) => {
      const list = byClass(cls);
      return [cls, { families: list.length, events: eventsOf(list).toString() }];
    })) as UtilizationReport["classes"],
    families: analyses.map((a) => ({
      category: a.category, title: a.title, count: a.count.toString(), shapes: a.shapes,
      recognizedShapes: a.recognizedShapes, route: a.route, recognized: a.recognized,
      partial: a.partial, normalized: a.normalized, analyticsUsed: a.analyticsUsed,
      valueBearing: a.valueBearing, familyClass: a.familyClass,
      oldest: a.oldest.toISOString(), newest: a.newest.toISOString(),
    })),
    reconciliation: reconRows,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("=== Raw event utilization audit 2.1 (read-only) ===");
  console.log(`RAW             families ${totalFamilies} · payload shapes ${totalShapes} · events ${totalEvents}`);
  console.log(`recognized      families ${pct(recognizedList.length, totalFamilies)} (${recognizedList.length}) · events ${pct(Number(eventsOf(recognizedList)), Number(totalEvents))}`);
  console.log(`NORMALIZATION   fully covered families ${report.normalization.fullyCoveredFamilies} · PARTIAL families ${report.normalization.partiallyCoveredFamilies} · unrecognized shapes ${report.normalization.unrecognizedShapes}`);
  console.log(`VALUE COVERAGE  shapes ${valueShapes.length} (${eventsOf(valueShapes)} events) · recognized ${pct(valueShapesRecognized.length, valueShapes.length)} (${eventsOf(valueShapesRecognized)} events) · UNCOVERED value shapes ${valueShapesUncovered.length} (${eventsOf(valueShapesUncovered)} events)`);
  console.log(`ACTIVITY        ActivityEvent rows ${report.activity.rows} · reportable ${report.activity.reportableRows} · semantic families ${report.activity.semanticFamilies}`);

  const classLabels: Record<FamilyClass, string> = {
    A: "A recognized (all shapes) + normalized + analytics-used",
    B: "B recognized + normalized but unused",
    C: "recognized but not (fully) normalized",
    D: "value-bearing but UNRECOGNIZED",
    E: "non-value / low-value informational",
    F: "PARTIAL — some payload shapes normalize, others do not",
  };
  for (const cls of ["A", "B", "C", "D", "E", "F"] as FamilyClass[]) {
    const list = byClass(cls);
    console.log(`\n[${classLabels[cls]}] ${list.length} families / ${eventsOf(list)} events`);
    if ((cls === "E" || cls === "A") && !showMatrix) {
      console.log(cls === "A" ? "  (covered — run with --matrix for the full per-family table)" : "  (informational — run with --matrix for the full per-family table)");
      continue;
    }
    for (const a of list.sort((x, y) => Number(y.count) - Number(x.count)).slice(0, showMatrix ? Infinity : 25)) {
      const shapeInfo = a.partial ? ` [${a.recognizedShapes}/${a.shapes} shapes]` : a.shapes > 1 ? ` [${a.shapes} shapes]` : "";
      console.log(`  ${String(a.count).padStart(7)}  ${String(a.oldest.getFullYear())}–${String(a.newest.getFullYear()).slice(2)}  ${a.route.padEnd(9)} ${a.category} | ${a.title}${shapeInfo}`);
    }
    if (!showMatrix && list.length > 25) console.log(`  … ${list.length - 25} more`);
  }

  // Uncovered value-bearing shapes — the precise gap list.
  if (valueShapesUncovered.length > 0) {
    console.log(`\n[Uncovered value-bearing shapes] ${valueShapesUncovered.length}`);
    const uncovered = valueShapesUncovered
      .map((s) => ({ s, sample: sampleByShape.get(`${s.category}|${s.title}|${s.shape ?? ""}`) }))
      .sort((a, b) => Number(b.s.count) - Number(a.s.count))
      .slice(0, 20);
    for (const { s } of uncovered) {
      console.log(`  ${String(s.count).padStart(7)}  ${s.category} | ${s.title} :: ${s.shape ?? "(no payload)"}`);
    }
  }

  // Casino reconciliation, decomposed for explainability.
  console.log("\nCasino reconciliation (semantic logical-play economics vs signed ledger):");
  if (reconRows.length === 0) console.log("  no casino activity normalized yet");
  for (const r of reconRows) {
    console.log(`  user ${r.userId}:`);
    console.log(`    semantic: wagered=${r.semanticWagered} returned=${r.semanticReturned} net=${r.semanticNet} withdrawalsExcluded=${r.withdrawals} pendingPlacements=${r.pending}`);
    console.log(`    ledger:   income=${r.ledgerIncome} expense=${r.ledgerExpense} net=${r.ledgerNet}`);
    const diff = r.difference === "n/a" ? null : BigInt(r.difference);
    console.log(`    diff=${r.difference}${diff !== null && diff !== 0n ? " (structural: slots/keno/blackjack/high-low/bookie cash has no money logs; lottery/wheel placements pending — surfaced, not patched)" : ""}`);
  }
}

/** Deterministic family → ActivityEvent.activityType key (what the
 *  normalizers would write), or null when the family maps to a non-activity
 *  normalizer (money/drugs/travel/... — those use MoneyEvent+own tables). */
function normalizerFamilyKey(category: string, title: string, data: LogRecord): string | null {
  const casino = normalizeCasinoLog(category, title, data);
  if (casino) return casino.activityType;
  const openable = normalizeOpenableLog(title, data);
  if (openable) return openable.activityType;
  const domain = normalizeDomainLog(category, title, data);
  if (domain) return domain.activityType;
  if (routeLog(category, title) === "casino") {
    // Legacy casino money logs normalize to casino-legacy via the repair.
    return "casino-legacy";
  }
  return null;
}

main().catch((err) => {
  console.error("activity utilization audit failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
