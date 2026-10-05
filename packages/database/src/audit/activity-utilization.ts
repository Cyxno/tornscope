import { getPrismaClient } from "../client.js";
import { normalizeCasinoLog } from "../normalizers/casino.js";
import { normalizeOpenableLog } from "../normalizers/openables.js";
import { normalizeDomainLog } from "../normalizers/domains.js";
import { routeLog } from "../normalizers/titles.js";
import type { LogRecord } from "../normalizers/extract.js";

/**
 * Raw-event utilization audit 2.0 (2.5.0) — operator/developer diagnostic
 * over the locally stored archive. Zero upstream calls; read-only.
 *
 *   pnpm --filter @tornscope/database audit:activities [--matrix]
 *
 * Per distinct (category, title) raw log family it decides:
 * - routed domain (routeLog) and whether any normalizer claims the family
 *   (decided against a fresh sample payload — route alone never counts)
 * - whether the family produced semantic rows (ActivityEvent domain/type or
 *   a MoneyEvent category)
 * - whether the semantic rows are analytics-used (carry reportable
 *   components)
 * - value-bearing-ness of the payload (value-shaped keys on the sample)
 *
 * Families are classified:
 *   A recognized + normalized + analytics-used
 *   B recognized + normalized but unused
 *   C recognized but not normalized
 *   D value-bearing but unrecognized        ← the actionable gap list
 *   E non-value / low-value informational
 *   F ambiguous (routed to a domain but the normalizer rejects the sample)
 *
 * Coverage is reported at BOTH family level and event level — never mixed
 * (a 1-event family and a 10k-event family count equally as families, and
 * proportionally as events).
 *
 * Also prints the generic money reconciliation: semantic ActivityEvent cash
 * delta vs MoneyEvent ledger delta per user+domain (MoneyEvent.amount is
 * SIGNED and summed directly). Semantic-only domains (whose cash never
 * flows through money logs) and known structural ledger gaps are disclosed,
 * never patched.
 */

/** Payload keys that indicate a potential money/reward value. */
const VALUE_KEYS = [
  "money", "amount", "bet", "bet_amount", "winnings", "cost", "won_amount",
  "losses", "points", "items", "item2", "credits", "income", "bounty_reward",
  "casino_tokens_increased", "racing_points",
] as const;

/** ActivityEvent domain → the MoneyEvent category expected to carry its
 *  cash (only casino maps; hunting/missions/racing/bounties/education cash
 *  is semantic-only by construction — Torn emits no money logs for them). */
const LEDGER_CATEGORY_BY_DOMAIN: Record<string, string> = { casino: "casino" };
const KNOWN_LEDGER_GAPS =
  "known structural ledger gaps: slots/keno/blackjack/high-low/bookie cash + pending placements";

interface FamilyRow {
  category: string;
  title: string;
  count: bigint;
  oldest: Date;
  newest: Date;
  sample: unknown;
}

type FamilyClass = "A" | "B" | "C" | "D" | "E" | "F";

interface FamilyAnalysis {
  category: string;
  title: string;
  count: bigint;
  oldest: Date;
  newest: Date;
  route: string;
  recognized: boolean;
  /** Normalizer claims the family type in principle, but rejected the sample. */
  routeButUnclaimed: boolean;
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

/** Routes served by established specialist normalizers (crimes, drugs,
 *  rehab, travel, itemuse consumables, money ledger). Their claim is the
 *  route itself — each has a dedicated table filled by the same sync and a
 *  consuming analytics surface. Activity-layer claims (casino/openable/
 *  domains) are decided by the normalizers against the sample payload. */
const SPECIALIST_ROUTES = new Set(["crimes", "drugs", "rehab", "travel", "itemuse", "money"]);

/** Does any normalizer claim this family? Decided on the sample payload. */
function normalizerClaim(category: string, title: string, data: LogRecord): boolean {
  if (normalizeCasinoLog(category, title, data)) return true;
  if (normalizeOpenableLog(title, data)) return true;
  if (normalizeDomainLog(category, title, data)) return true;
  return false;
}

export function analyzeFamily(
  category: string,
  title: string,
  sample: unknown,
  normalized: boolean,
  analyticsUsed: boolean,
): FamilyAnalysis {
  const data = payloadOf(sample);
  const route = routeLog(category, title);
  const specialist = SPECIALIST_ROUTES.has(route);
  const claimed = specialist || normalizerClaim(category, title, data);
  const routeButUnclaimed = route !== "timeline" && !claimed;
  // A family is "recognized" when a normalizer claims it — a bare route
  // match without payload semantics (class F) is not recognition.
  const recognized = claimed;
  const valueBearing = isValueBearing(data);

  let familyClass: FamilyClass;
  if (recognized && normalized && analyticsUsed) familyClass = "A";
  else if (recognized && normalized) familyClass = "B";
  else if (recognized) familyClass = "C";
  else if (routeButUnclaimed && valueBearing) familyClass = "F";
  else if (routeButUnclaimed) familyClass = "F";
  else if (valueBearing) familyClass = "D";
  else familyClass = "E";

  return {
    category, title, count: 0n, oldest: new Date(0), newest: new Date(0),
    route, recognized, routeButUnclaimed, normalized, analyticsUsed, valueBearing, familyClass,
  };
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const showMatrix = process.argv.includes("--matrix");
  const db = getPrismaClient();

  // One grouped scan for families, one DISTINCT ON scan for per-family
  // sample payloads, plus semantic-row rollups. All read-only.
  const [familyCounts, samples, activityByFamily, activityByDomain, ledgerCats, ledgerByUserCategory] = await Promise.all([
    db.$queryRawUnsafe<Array<{ category: string; title: string; count: bigint; oldest: Date; newest: Date }>>(
      `SELECT "category", "title", count(*)::bigint AS count,
              min("occurredAt") AS oldest, max("occurredAt") AS newest
       FROM "TimelineEvent" WHERE "type" = 'log'
       GROUP BY 1, 2`,
    ),
    db.$queryRawUnsafe<FamilyRow[]>(
      `SELECT DISTINCT ON ("category", "title") "category", "title", "occurredAt", min("occurredAt") OVER (PARTITION BY "category", "title") AS oldest,
              max("occurredAt") OVER (PARTITION BY "category", "title") AS newest, "metadata" AS sample
       FROM "TimelineEvent" WHERE "type" = 'log'
       ORDER BY "category", "title", "occurredAt" DESC`,
    ),
    // ActivityEvent families (domain, activityType) with component presence.
    db.$queryRawUnsafe<Array<{ domain: string; activityType: string; count: bigint; withComponents: bigint }>>(
      `SELECT domain, "activityType", count(*)::bigint AS count,
              count(*) FILTER (WHERE "cashReward" IS NOT NULL OR "cashInput" IS NOT NULL
                                  OR "pointsReward" IS NOT NULL OR "tokensReward" IS NOT NULL
                                  OR "netValue" IS NOT NULL OR metadata ? 'items'
                                  OR metadata ? 'item2')::bigint AS "withComponents"
       FROM "ActivityEvent" GROUP BY 1, 2`,
    ),
    db.$queryRawUnsafe<Array<{ user_id: string; domain: string; activity_cash: string; rows: bigint }>>(
      `SELECT "userId" AS user_id, domain,
              sum(COALESCE("cashReward",0) - COALESCE("cashInput",0))::text AS activity_cash,
              count(*)::bigint AS rows
       FROM "ActivityEvent" WHERE "cashReward" IS NOT NULL OR "cashInput" IS NOT NULL
       GROUP BY 1, 2`,
    ),
    db.$queryRawUnsafe<Array<{ description: string }>>(
      // MoneyEvent.description stores the raw log title — exact family link.
      `SELECT DISTINCT "description" FROM "MoneyEvent" WHERE "description" IS NOT NULL AND "description" <> ''`,
    ),
    db.$queryRawUnsafe<Array<{ user_id: string; category: string; ledger_cash: string }>>(
      // MoneyEvent.amount is SIGNED (expenses negative) — summed directly.
      `SELECT "userId" AS user_id, category, sum(amount)::text AS ledger_cash
       FROM "MoneyEvent" GROUP BY 1, 2`,
    ),
  ]);

  const sampleByFamily = new Map(samples.map((s) => [`${s.category} | ${s.title}`, s.sample]));
  const ledgerTitleSet = new Set(ledgerCats.map((r) => r.description));
  // ActivityEvent (domain, activityType) → (rows, used rows). A family maps
  // to activityType via the normalizers' deterministic outputs; matching by
  // type prefix keeps legacy/openable families exact (openable-<id>,
  // casino games, domain types).
  const activityKeyByType = new Map(activityByFamily.map((r) => [r.activityType, r]));

  const analyses: FamilyAnalysis[] = [];
  for (const f of familyCounts) {
    const sample = sampleByFamily.get(`${f.category} | ${f.title}`);
    const data = payloadOf(sample);
    // Normalized? Deterministic mapping from family → semantic family:
    const domainType = normalizerFamilyKey(f.category, f.title, data);
    const activityRow = domainType ? activityKeyByType.get(domainType) : undefined;
    const route = routeLog(f.category, f.title);
    // Money-route families normalize into MoneyEvent — check the planned
    // ledger category actually has rows. Other specialist routes (drugs,
    // travel, rehab, itemuse, crimes) have dedicated tables filled by the
    // same sync; their normalization presence is taken as given (the
    // matrix's signal focuses on activity/ledger gaps).
    // MoneyEvent.subcategory stores the log title — exact family presence.
    const hasLedgerRows = route === "money" ? ledgerTitleSet.has(f.title) : false;
    const specialistRoute = ["drugs", "rehab", "travel", "itemuse", "crimes"].includes(route);
    const normalized = Boolean(activityRow && activityRow.count > 0n) || hasLedgerRows || specialistRoute;
    // Specialist-route families feed dedicated analytics surfaces (money
    // page, drugs/travel/crimes pages, log explorer) — used by definition.
    const analyticsUsed = specialistRoute || route === "money" || Boolean(activityRow && activityRow.withComponents > 0n);
    const a = analyzeFamily(f.category, f.title, sample, normalized, analyticsUsed);
    a.count = f.count;
    a.oldest = f.oldest;
    a.newest = f.newest;
    analyses.push(a);
  }

  // Coverage: family-level and event-level, never mixed.
  const totalFamilies = analyses.length;
  const totalEvents = analyses.reduce((acc, a) => acc + a.count, 0n);
  const byClass = (cls: FamilyClass) => analyses.filter((a) => a.familyClass === cls);
  const eventsOf = (list: FamilyAnalysis[]) => list.reduce((acc, a) => acc + a.count, 0n);
  const recognizedList = analyses.filter((a) => a.recognized);
  const valueBearing = analyses.filter((a) => a.valueBearing);
  const valueRecognized = valueBearing.filter((a) => a.recognized);
  const valueNormalized = valueBearing.filter((a) => a.normalized);
  const valueUsed = valueBearing.filter((a) => a.analyticsUsed);

  console.log("=== Raw event utilization audit 2.0 (read-only) ===");
  console.log(`raw log families: ${totalFamilies} (${totalEvents} events)`);
  console.log(`recognized:  families ${pct(recognizedList.length, totalFamilies)} (${recognizedList.length}) · events ${pct(Number(eventsOf(recognizedList)), Number(totalEvents))}`);
  console.log(`value-bearing coverage (of ${valueBearing.length} value-bearing families / ${eventsOf(valueBearing)} events):`);
  console.log(`  recognized     families ${pct(valueRecognized.length, valueBearing.length)} · events ${pct(Number(eventsOf(valueRecognized)), Number(eventsOf(valueBearing)))}`);
  console.log(`  normalized     families ${pct(valueNormalized.length, valueBearing.length)} · events ${pct(Number(eventsOf(valueNormalized)), Number(eventsOf(valueBearing)))}`);
  console.log(`  analytics-used families ${pct(valueUsed.length, valueBearing.length)} · events ${pct(Number(eventsOf(valueUsed)), Number(eventsOf(valueBearing)))}`);

  const classLabels: Record<FamilyClass, string> = {
    A: "A recognized + normalized + analytics-used",
    B: "B recognized + normalized but unused",
    C: "recognized but not normalized",
    D: "value-bearing but UNRECOGNIZED",
    E: "non-value / low-value informational",
    F: "ambiguous (routed, normalizer rejects sample)",
  };
  for (const cls of ["A", "B", "C", "D", "E", "F"] as FamilyClass[]) {
    const list = byClass(cls);
    console.log(`\n[${classLabels[cls]}] ${list.length} families / ${eventsOf(list)} events`);
    if (cls === "E" && !showMatrix) continue; // E is long and low-value
    if (cls === "A" && !showMatrix) {
      console.log(`  (covered — run with --matrix for the full per-family table)`);
      continue;
    }
    for (const a of list.sort((x, y) => Number(y.count) - Number(x.count)).slice(0, showMatrix ? Infinity : 25)) {
      console.log(`  ${String(a.count).padStart(7)}  ${String(a.oldest.getFullYear())}–${String(a.newest.getFullYear()).slice(2)}  ${a.route.padEnd(9)} ${a.category} | ${a.title}`);
    }
    if (!showMatrix && list.length > 25) console.log(`  … ${list.length - 25} more`);
  }

  // Generic money reconciliation (Fase 4): per user+domain, semantic cash
  // delta vs ledger delta. Correct signs; semantic-only domains disclosed.
  const ledgerByUserCategoryMap = new Map(ledgerByUserCategoryRows(ledgerByUserCategory));
  console.log("\nMoney reconciliation (semantic ActivityEvent cash vs MoneyEvent ledger, signed):");
  const byUserDomain = new Map<string, bigint>();
  for (const row of activityByDomain) byUserDomain.set(`${row.user_id}|${row.domain}`, BigInt(row.activity_cash));
  for (const [key, activityCash] of [...byUserDomain.entries()].sort()) {
    const [userId, domain] = key.split("|");
    const ledgerCategory = LEDGER_CATEGORY_BY_DOMAIN[domain!];
    if (!ledgerCategory) {
      console.log(`  user ${userId} ${domain}: activity=${activityCash} ledger=n/a (semantic-only domain — Torn emits no money logs for it)`);
      continue;
    }
    const ledgerCash = ledgerByUserCategoryMap.get(`${userId}|${ledgerCategory}`) ?? 0n;
    const diff = activityCash - ledgerCash;
    console.log(`  user ${userId} ${domain}: activity=${activityCash} ledger=${ledgerCash} diff=${diff}${diff !== 0n ? ` (${KNOWN_LEDGER_GAPS} — surfaced, not patched)` : ""}`);
  }
  if (activityByDomain.length === 0) console.log("  no valued ActivityEvents yet");
}

function ledgerByUserCategoryRows(rows: Array<{ user_id: string; category: string; ledger_cash: string }>): Array<[string, bigint]> {
  return rows.map((r) => [`${r.user_id}|${r.category}`, BigInt(r.ledger_cash)]);
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
