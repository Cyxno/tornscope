import {
  resolveDateRange,
  type ActivitySummaryResponse,
  type DateRangeInput,
} from "@tornscope/shared";
import { bigintToNumber, getPrismaClient } from "@tornscope/database";
import { loadAvailabilityContext, sectionAvailability } from "./availability.js";
import { estimateOpenableItemValuation } from "./rewards.js";
import { aggregateCasinoEconomics } from "@tornscope/database";
import { loadCasinoRows } from "./casino-economics.js";

/**
 * Cross-domain value attribution (2.5.0) — one bounded, server-side view
 * over ALL normalized ActivityEvent domains: exact cash, estimated item
 * value, unpriced rewards and progression quantities, with honest
 * ledger linkage (casino cash also flows through MoneyEvent; hunting/
 * missions/racing/bounties/education cash is semantic-only because Torn
 * emits no money logs for it). Nothing is collapsed into one questionable
 * "total profit" — exact and estimated stay separate columns, and the
 * casino reconciliation difference is disclosed, never patched.
 */

const DOMAIN_LABELS: Array<{ domain: string; label: string }> = [
  { domain: "casino", label: "Casino" },
  { domain: "openable", label: "Openables & rewards" },
  { domain: "hunting", label: "Hunting" },
  { domain: "missions", label: "Missions" },
  { domain: "racing", label: "Racing" },
  { domain: "bounties", label: "Bounties" },
  { domain: "education", label: "Education" },
  { domain: "special", label: "Special rewards" },
];

interface DomainAggregate {
  domain: string;
  count: bigint;
  cashInput: bigint | null;
  cashReward: bigint | null;
  netValue: bigint | null;
  points: bigint | null;
  tokens: bigint | null;
  unpriced: bigint;
  lastActivityAt: Date | null;
}

export async function getActivitySummary(userId: string, rangeInput: DateRangeInput): Promise<ActivitySummaryResponse> {
  const db = getPrismaClient();
  const range = resolveDateRange(rangeInput);
  const availCtx = await loadAvailabilityContext(userId);
  const fromDate = new Date(range.from * 1000);
  const toDate = new Date(range.to * 1000);

  const windowWhere = {
    userId,
    occurredAt: { gte: fromDate, lte: toDate },
  };

  const [byDomain, breakdownRows, oldest, itemValuation, casinoRows] = await Promise.all([
    // One grouped scan for all domains — never per-domain queries.
    db.$queryRawUnsafe<Array<{
      domain: string; count: bigint; cash_input: string | null; cash_reward: string | null;
      net_value: string | null; points: string | null; tokens: string | null; unpriced: bigint; last_at: Date | null;
    }>>(
      `SELECT domain, count(*)::bigint AS count,
              sum("cashInput")::text AS cash_input, sum("cashReward")::text AS cash_reward,
              sum("netValue")::text AS net_value,
              sum("pointsReward")::text AS points, sum("tokensReward")::text AS tokens,
              count(*) FILTER (WHERE valuation = 'unpriced')::bigint AS unpriced,
              max("occurredAt") AS last_at
       FROM "ActivityEvent"
       WHERE "userId" = $1 AND "occurredAt" BETWEEN $2 AND $3
       GROUP BY domain`,
      userId, fromDate, toDate,
    ),
    db.activityEvent.groupBy({
      by: ["domain", "activityType", "subtype"],
      where: windowWhere,
      _count: { _all: true },
      _sum: { cashInput: true, cashReward: true, netValue: true, pointsReward: true, tokensReward: true },
    }),
    db.activityEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    estimateOpenableItemValuation(userId, fromDate, toDate),
    // Casino economics need logical-play ownership (stakes once, withdrawals
    // excluded) — raw sums would double-count settled stakes.
    loadCasinoRows(db, userId, fromDate, toDate),
  ]);
  const casinoEco = aggregateCasinoEconomics(casinoRows);

  const toNum = (v: string | bigint | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    return typeof v === "bigint" ? bigintToNumber(v) : Number(v);
  };

  const byDomainMap = new Map(byDomain.map((r) => [r.domain, r]));
  const breakdownByDomain = new Map<string, typeof breakdownRows>();
  for (const row of breakdownRows) {
    const list = breakdownByDomain.get(row.domain) ?? [];
    list.push(row);
    breakdownByDomain.set(row.domain, list);
  }

  // Casino ledger reconciliation (signed sums) — disclosed, never patched.
  const [casinoLedgerRows] = await Promise.all([
    db.$queryRawUnsafe<Array<{ user_id: string; ledger_cash: string }>>(
      // MoneyEvent.amount is SIGNED (expenses negative) — summed directly.
      `SELECT "userId" AS user_id, sum(amount)::text AS ledger_cash
       FROM "MoneyEvent" WHERE category = 'casino' GROUP BY 1`,
    ),
  ]);
  const ledgerByUser = new Map(casinoLedgerRows.map((r) => [r.user_id, toNum(r.ledger_cash)]));

  const domains = DOMAIN_LABELS
    .filter(({ domain }) => byDomainMap.has(domain))
    .map(({ domain, label }) => {
      const agg = byDomainMap.get(domain)!;
      const breakdown = (breakdownByDomain.get(domain) ?? [])
        .map((b) => ({
          activityType: b.activityType,
          subtype: b.subtype,
          count: b._count._all,
          cashSpent: toNum(b._sum.cashInput),
          cashReceived: toNum(b._sum.cashReward),
          net: toNum(b._sum.netValue),
          points: b._sum.pointsReward === null ? null : Number(b._sum.pointsReward),
          tokens: b._sum.tokensReward === null ? null : Number(b._sum.tokensReward),
        }))
        .sort((a, b) => b.count - a.count);
      const isCasino = domain === "casino";
      return {
        domain,
        label,
        activities: Number(agg.count),
        cashSpent: isCasino ? toNum(casinoEco.wagered) : toNum(agg.cash_input),
        cashReceived: isCasino ? toNum(casinoEco.returned) : toNum(agg.cash_reward),
        exactNetCash: isCasino ? toNum(casinoEco.net) : toNum(agg.net_value),
        estimatedItemValue: domain === "openable" ? itemValuation.rewardValueEstimate : null,
        unpricedActivities: Number(agg.unpriced),
        progressionPoints: agg.points === null ? null : Number(agg.points),
        progressionTokens: agg.tokens === null ? null : Number(agg.tokens),
        ledgerLinked: domain === "casino",
        lastActivityAt: agg.last_at ? Math.floor(agg.last_at.getTime() / 1000) : null,
        breakdown,
      };
    });

  const totalActivities = byDomain.reduce((acc, r) => acc + Number(r.count), 0);
  const exactNet = byDomain.reduce((acc, r) => acc + BigInt(r.domain === "casino" ? (casinoEco.net ?? 0n) : (r.net_value ?? 0n)), 0n);
  const hasNet = byDomain.some((r) => (r.domain === "casino" ? casinoEco.net !== null : r.net_value !== null));
  const totalActivitiesCount = await db.activityEvent.count({ where: windowWhere });
  const userIdForRecon = userId;
  // Semantic casino cash uses logical-play economics (stakes once, no
  // withdrawals) so the reconciliation explains real differences.
  const casinoActivity = toNum(casinoEco.net);
  const casinoLedger = ledgerByUser.get(userIdForRecon) ?? null;

  const reconciliation: ActivitySummaryResponse["reconciliation"] = domains
    .filter((d) => d.cashSpent !== null || d.cashReceived !== null)
    .map((d) => {
      if (d.domain === "casino") {
        const diff = casinoActivity !== null && casinoLedger !== null ? casinoActivity - casinoLedger : null;
        return {
          domain: d.domain,
          activityCash: casinoActivity,
          ledgerCash: casinoLedger,
          difference: diff,
          semanticOnly: false,
          note: diff !== null && diff !== 0
            ? "Structural ledger gaps: slots/keno/blackjack/high-low/bookie cash never appears in money logs; lottery/wheel placements are pending. Surfaced, not patched."
            : null,
        };
      }
      return {
        domain: d.domain,
        activityCash: d.exactNetCash,
        ledgerCash: null,
        difference: null,
        semanticOnly: true,
        note: "Semantic-only domain — Torn emits no money logs for it; reported here and nowhere else (no double counting).",
      };
    });

  return {
    range: { from: range.from, to: range.to },
    activities: totalActivitiesCount,
    exactNetCash: hasNet ? toNum(exactNet) : null,
    estimatedItemValue: { value: itemValuation.anyItems ? itemValuation.rewardValueEstimate : null, provenance: "estimated" },
    unpricedActivities: byDomain.reduce((acc, r) => acc + Number(r.unpriced), 0),
    domains,
    reconciliation,
    coverage: {
      activities: totalActivities,
      trackingSince: oldest ? Math.floor(oldest.occurredAt.getTime() / 1000) : null,
    },
    availability: {
      history: sectionAvailability(availCtx, "timeline_history", "events"),
    },
  };
}
