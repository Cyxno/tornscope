import { z } from "zod";
import { MONEY_CATEGORIES, MONEY_DIRECTIONS, SYNC_RESOURCES } from "./torn.js";
import type { Provenance } from "./provenance.js";

/* -------------------------------------------------------------------------- */
/* Date range                                                                 */
/* -------------------------------------------------------------------------- */

export const DATE_RANGE_PRESETS = [
  "today",
  "1d",
  "7d",
  "14d",
  "30d",
  "90d",
  "this_month",
  "prev_month",
  "this_year",
  "all",
  "custom",
] as const;

export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const DateRangeSchema = z.object({
  preset: z.enum(DATE_RANGE_PRESETS).default("30d"),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
});
export type DateRangeInput = z.infer<typeof DateRangeSchema>;

export interface DateRange {
  from: number; // unix seconds (inclusive)
  to: number; // unix seconds (inclusive)
}

function startOfDayUtc(tsSeconds: number): number {
  const d = new Date(tsSeconds * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/**
 * Resolve a date range input to concrete UTC bounds.
 * `now` is injectable for tests. All boundaries are unix seconds.
 */
export function resolveDateRange(input: DateRangeInput, now: number = Math.floor(Date.now() / 1000)): DateRange {
  const to = input.to ?? now;
  const startOfToday = startOfDayUtc(now);
  const endOfToday = startOfToday + 86_399;

  switch (input.preset) {
    case "today":
    case "1d":
      return { from: startOfToday, to: endOfToday };
    case "7d":
      return { from: startOfToday - 6 * 86_400, to: endOfToday };
    case "14d":
      return { from: startOfToday - 13 * 86_400, to: endOfToday };
    case "30d":
      return { from: startOfToday - 29 * 86_400, to: endOfToday };
    case "90d":
      return { from: startOfToday - 89 * 86_400, to: endOfToday };
    case "this_month": {
      const d = new Date(now * 1000);
      return { from: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000), to: endOfToday };
    }
    case "prev_month": {
      const d = new Date(now * 1000);
      const first = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000);
      return { from: first, to: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000) - 1 };
    }
    case "this_year": {
      const d = new Date(now * 1000);
      return { from: Math.floor(Date.UTC(d.getUTCFullYear(), 0, 1) / 1000), to: endOfToday };
    }
    case "all":
      return { from: 0, to: endOfToday };
    case "custom": {
      if (input.from === undefined) {
        return { from: startOfToday - 29 * 86_400, to: endOfToday };
      }
      return { from: input.from, to: Math.min(input.to ?? endOfToday, endOfToday) };
    }
  }
}

/**
 * Short human label for a range preset, used to prefix KPI labels so they
 * always match the selected period ("7D income", "This Year networth change").
 */
export function periodLabel(preset: DateRangePreset): string {
  switch (preset) {
    case "today":
      return "Today";
    case "1d":
      return "1D";
    case "7d":
      return "7D";
    case "14d":
      return "14D";
    case "30d":
      return "30D";
    case "90d":
      return "90D";
    case "this_month":
      return "This Month";
    case "prev_month":
      return "Last Month";
    case "this_year":
      return "This Year";
    case "all":
      return "All";
    case "custom":
      return "Custom";
  }
}

/**
 * Pick a chart bucketing interval appropriate for the range span.
 * Automatic sensible interval selection (hour/day/week/month).
 */
export function autoInterval(range: DateRange): "hour" | "day" | "week" | "month" {
  const spanDays = Math.max(0, (range.to - range.from) / 86_400);
  if (spanDays <= 2) return "hour";
  if (spanDays <= 92) return "day";
  if (spanDays <= 366) return "week";
  return "month";
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(256).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/* -------------------------------------------------------------------------- */
/* Provenance-aware values                                                    */
/* -------------------------------------------------------------------------- */

export const ProvenanceSchema = z.enum(["exact", "derived", "estimated"]);

/**
 * Data-quality state for a displayed figure. The UI must never show a
 * misleading $0:
 * - ok           confirmed value ($0 really is zero)
 * - unavailable  not computable from collected data ("—")
 * - importing    the historical backfill is still running
 * - incomplete   parser coverage insufficient; value may change on re-import
 */
export const KpiAvailabilitySchema = z.enum(["ok", "unavailable", "importing", "incomplete"]);
export type KpiAvailability = z.infer<typeof KpiAvailabilitySchema>;

/* -------------------------------------------------------------------------- */
/* API response contracts                                                     */
/* -------------------------------------------------------------------------- */

export const MoneyCategorySchema = z.enum(MONEY_CATEGORIES);
export const MoneyDirectionSchema = z.enum(MONEY_DIRECTIONS);
export const SyncResourceSchema = z.enum(SYNC_RESOURCES);

export const MeResponseSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  /** IANA timezone used for rendering human-readable times (default UTC). */
  timezone: z.string(),
  isDemo: z.boolean(),
  torn: z
    .object({
      tornId: z.number(),
      name: z.string(),
      level: z.number(),
      rank: z.string().nullable(),
      factionId: z.number().nullable(),
      factionName: z.string().nullable(),
    })
    .nullable(),
  hasApiKey: z.boolean(),
  needsOnboarding: z.boolean(),
  /** A demo dataset exists and can be explored (no API key required). */
  demoAvailable: z.boolean(),
  syncHealth: z.object({
    lastSuccessAt: z.number().nullable(),
    running: z.boolean(),
    errorCount: z.number(),
  }),
  /**
   * First-run phase (no_key / queued / syncing / partial / caught_up / failed)
   * derived from the per-resource sync states — the UI uses this to let the
   * player in as soon as basic account data is live instead of blocking on
   * the historical backfill.
   */
  setupPhase: z.enum(["no_key", "queued", "syncing", "partial", "caught_up", "failed"]),
  /** Deployed build identifier (git sha injected at Docker build time). */
  build: z.object({ commit: z.string() }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const KpiValueSchema = z.object({
  value: z.number().nullable(),
  provenance: ProvenanceSchema,
  label: z.string().optional(),
  /** Data-quality state; absent means "ok". UI renders $0 only when ok. */
  availability: KpiAvailabilitySchema.optional(),
});
export type KpiValue = z.infer<typeof KpiValueSchema>;

/**
 * Coverage of the tracked history for a networth period change — the UI maps
 * this to "Networth change" (full) / "Tracked period change" (partial) /
 * "Insufficient history" (none). Never renders a misleading 0.
 */
export const NetworthCoverageSchema = z.enum(["full", "partial", "none"]);
export type NetworthCoverage = z.infer<typeof NetworthCoverageSchema>;

export const NetworthCategoryChangeSchema = z.object({
  key: z.enum(["cash", "banks", "stocks", "items", "property", "points", "company", "other"]),
  label: z.string(),
  current: z.number(),
  baseline: z.number(),
  change: z.number(),
});
export type NetworthCategoryChangeDto = z.infer<typeof NetworthCategoryChangeSchema>;

export const DashboardResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number(), interval: z.string() }),
  netWorth: KpiValueSchema,
  cash: KpiValueSchema,
  /** Cash flow over the SELECTED range — labels are built from the range. */
  income: KpiValueSchema,
  expenses: KpiValueSchema,
  netCashFlow: KpiValueSchema,
  /** Networth snapshot change over the SELECTED range. */
  networthChange: KpiValueSchema,
  networthChangePct: z.number().nullable(),
  networthCoverage: NetworthCoverageSchema,
  /** Earliest real networth snapshot — charts/labels must not predate it. */
  networthTrackingSince: z.number().nullable(),
  /** Crimes summary over the selected range (null when no data at all). */
  crimes: z
    .object({
      attempts: z.number(),
      successRate: z.number().nullable(),
      totalValue: z.number().nullable(),
    })
    .nullable(),
  /** Combat summary over the selected range (null when no data at all). */
  combat: z
    .object({
      attacksMade: z.number(),
      wins: z.number(),
    })
    .nullable(),
  /** Faction summary: latest ranked war + personal payouts in range. */
  faction: z
    .object({
      name: z.string().nullable(),
      lastWar: z
        .object({
          opponentName: z.string().nullable(),
          result: z.enum(["win", "loss", "ongoing", "draw"]),
          endedAt: z.number().nullable(),
        })
        .nullable(),
      myPayouts: z.number(),
    })
    .nullable(),
  consumedValue: KpiValueSchema,
  travelProfit: KpiValueSchema,
  drugsUsed: KpiValueSchema,
  rehabSpend: KpiValueSchema,
  networthSeries: z.array(z.object({ t: z.number(), total: z.number() })),
  incomeByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
  expensesByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
  travelProfitSeries: z.array(z.object({ t: z.number(), profit: z.number() })),
  drugUseSeries: z.array(z.object({ t: z.number(), good: z.number(), bad: z.number() })),
  recentTimeline: z.array(
    z.object({
      id: z.string(),
      occurredAt: z.number(),
      type: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      amount: z.number().nullable(),
    })
  ),
  lastSyncAt: z.number().nullable(),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

export const MoneySummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number(), interval: z.string() }),
  totalIncome: KpiValueSchema,
  totalExpenses: KpiValueSchema,
  netProfit: KpiValueSchema,
  largestIncomeCategory: z.object({ category: MoneyCategorySchema.nullable(), total: z.number().nullable() }),
  largestExpenseCategory: z.object({ category: MoneyCategorySchema.nullable(), total: z.number().nullable() }),
  incomeByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
  expensesByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
  flowSeries: z.array(z.object({ t: z.number(), income: z.number(), expenses: z.number() })),
  cumulativeNetSeries: z.array(z.object({ t: z.number(), net: z.number() })),
});
export type MoneySummaryResponse = z.infer<typeof MoneySummaryResponseSchema>;

/**
 * Economy view: three clearly separated concepts.
 * - Cash Flow: ONLY real cash movements (purchases, sales, fees, payouts).
 * - Consumption: value of items used up (drugs, boosters, medical, happy
 *   items, other) — never added to the cash P&L.
 * - Networth: Torn snapshot totals and their change over the period.
 * Plus the estimated travel profit, kept separate from all of the above.
 */
export const EconomySummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number(), interval: z.string() }),
  cashFlow: z.object({
    income: KpiValueSchema,
    expenses: KpiValueSchema,
    netCashFlow: KpiValueSchema,
    /** Unclassified money rows in range — value may still change. */
    unclassifiedCount: z.number(),
    incomeByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
    expensesByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
  }),
  consumption: z.object({
    uses: z.number(),
    /** Total Consumed Value (known values; unknown-value events counted separately). */
    totalValue: KpiValueSchema,
    valueUnknownCount: z.number(),
    drugValue: z.number().nullable(),
    byCategory: z.array(
      z.object({
        category: z.string(),
        uses: z.number(),
        totalValue: z.number().nullable(),
        valueUnknownCount: z.number(),
      })
    ),
  }),
  networth: z.object({
    current: KpiValueSchema,
    currentAt: z.number().nullable(),
    baseline: z.number().nullable(),
    change: KpiValueSchema,
    changePct: z.number().nullable(),
    coverage: NetworthCoverageSchema,
    baselineAt: z.number().nullable(),
    trackedFrom: z.number().nullable(),
    byCategory: z.array(NetworthCategoryChangeSchema),
    /** Earliest real networth snapshot ("Tracking since"). */
    trackingSince: z.number().nullable(),
  }),
  travel: z.object({
    estimatedProfit: KpiValueSchema,
    profitPerHour: KpiValueSchema,
    trips: z.number(),
  }),
});
export type EconomySummaryResponse = z.infer<typeof EconomySummaryResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Crimes & Combat                                                             */
/* -------------------------------------------------------------------------- */

export const CrimeEventDtoSchema = z.object({
  id: z.string(),
  occurredAt: z.number(),
  crimeName: z.string().nullable(),
  crimeCategory: z.string().nullable(),
  success: z.boolean(),
  nerveUsed: z.number().nullable(),
  moneyDelta: z.number().nullable(),
  itemsValue: z.number().nullable(),
  jailSeconds: z.number().nullable(),
});
export type CrimeEventDto = z.infer<typeof CrimeEventDtoSchema>;

export const CrimesSummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  attempts: z.number(),
  successful: z.number(),
  failed: z.number(),
  successRate: z.number().nullable(),
  moneyGained: z.number(),
  moneyLost: z.number(),
  netCrimeCash: z.number(),
  estimatedItemsValue: z.number().nullable(),
  totalEstimatedValue: z.number().nullable(),
  nerveUsed: z.number().nullable(),
  valuePerNerve: z.number().nullable(),
  jailedCount: z.number(),
  totalJailSeconds: z.number(),
  crimesPerDay: z.number(),
  byCrime: z.array(
    z.object({
      crime: z.string(),
      attempts: z.number(),
      successes: z.number(),
      successRate: z.number().nullable(),
      cashGained: z.number(),
      cashLost: z.number(),
      estimatedItemsValue: z.number().nullable(),
      netValue: z.number().nullable(),
      nerveUsed: z.number().nullable(),
      valuePerNerve: z.number().nullable(),
    })
  ),
  dailySeries: z.array(z.object({ t: z.number(), attempts: z.number(), successes: z.number(), value: z.number() })),
  coverage: z.object({
    trackingSince: z.number().nullable(),
    earliestStored: z.number().nullable(),
    latestStored: z.number().nullable(),
  }),
});
export type CrimesSummaryResponse = z.infer<typeof CrimesSummaryResponseSchema>;

export const CrimesTimelineResponseSchema = z.object({
  nextCursor: z.string().nullable(),
  range: z.object({ from: z.number(), to: z.number() }),
  items: z.array(CrimeEventDtoSchema),
});
export type CrimesTimelineResponse = z.infer<typeof CrimesTimelineResponseSchema>;

export const CombatEventDtoSchema = z.object({
  id: z.string(),
  occurredAt: z.number(),
  direction: z.enum(["outgoing", "incoming"]),
  opponentName: z.string().nullable(),
  result: z.string(),
  respectDelta: z.number().nullable(),
});
export type CombatEventDto = z.infer<typeof CombatEventDtoSchema>;

export const OpponentRowSchema = z.object({
  opponentId: z.number().nullable(),
  opponent: z.string(),
  attacks: z.number(),
  wins: z.number(),
  losses: z.number(),
  winRate: z.number().nullable(),
  lastEncounter: z.number(),
});

export const CombatSummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  attacksMade: z.number(),
  attacksReceived: z.number(),
  wins: z.number(),
  losses: z.number(),
  winRate: z.number().nullable(),
  mugsMade: z.number(),
  mugsReceived: z.number(),
  moneyMugged: KpiValueSchema,
  moneyLostToMugs: KpiValueSchema,
  hospitalizationsCaused: z.number(),
  hospitalizationsReceived: z.number(),
  respectGained: z.number().nullable(),
  respectLost: z.number().nullable(),
  byOpponent: z.array(OpponentRowSchema),
  dailySeries: z.array(z.object({ t: z.number(), made: z.number(), received: z.number(), wins: z.number(), losses: z.number() })),
  coverage: z.object({
    trackingSince: z.number().nullable(),
    earliestStored: z.number().nullable(),
    latestStored: z.number().nullable(),
  }),
});
export type CombatSummaryResponse = z.infer<typeof CombatSummaryResponseSchema>;

export const CombatTimelineResponseSchema = z.object({
  nextCursor: z.string().nullable(),
  range: z.object({ from: z.number(), to: z.number() }),
  items: z.array(CombatEventDtoSchema),
});
export type CombatTimelineResponse = z.infer<typeof CombatTimelineResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Faction                                                                     */
/* -------------------------------------------------------------------------- */

export const FactionInfoSchema = z.object({
  factionId: z.number().nullable(),
  name: z.string().nullable(),
  tag: z.string().nullable(),
  respect: z.number().nullable(),
  members: z.number().nullable(),
  bestChain: z.number().nullable(),
  rankName: z.string().nullable(),
  rankWins: z.number().nullable(),
});

export const RankedWarRowSchema = z.object({
  tornWarId: z.number(),
  opponentName: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  result: z.enum(["win", "loss", "ongoing", "draw"]),
  ourScore: z.number().nullable(),
  opponentScore: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  knownPayoutTotal: z.number(),
  personalPayout: z.number().nullable(),
  myAttacks: z.number(),
  myWins: z.number(),
  myRespect: z.number(),
  linkage: z.enum(["exact", "time_window_match", "unmatched"]),
});
export type RankedWarRow = z.infer<typeof RankedWarRowSchema>;

export const FactionOverviewResponseSchema = z.object({
  faction: FactionInfoSchema,
  membership: z.object({
    isMember: z.boolean(),
    joinedAt: z.number().nullable(),
    position: z.string().nullable(),
    daysInFaction: z.number().nullable(),
  }),
  currentWar: z
    .object({
      tornWarId: z.number(),
      opponentName: z.string().nullable(),
      startedAt: z.number(),
      ourScore: z.number().nullable(),
      opponentScore: z.number().nullable(),
      targetScore: z.number().nullable(),
      myAttacks: z.number(),
      myRespect: z.number(),
    })
    .nullable(),
  currentChain: z
    .object({
      chain: z.number(),
      max: z.number().nullable(),
      startedAt: z.number().nullable(),
    })
    .nullable(),
  balance: z
    .object({
      money: z.number().nullable(),
      points: z.number().nullable(),
      capturedAt: z.number().nullable(),
    })
    .nullable(),
  wars: z.object({ total: z.number(), wins: z.number(), losses: z.number(), ongoing: z.number() }),
  payouts: z.object({ knownTotal: z.number(), personalTotal: z.number() }),
  coverage: z.object({
    warsEarliest: z.number().nullable(),
    warsLatest: z.number().nullable(),
    chainsStored: z.number(),
    ocsStored: z.number(),
  }),
});
export type FactionOverviewResponse = z.infer<typeof FactionOverviewResponseSchema>;

export const FactionRankedWarsResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  wars: z.array(RankedWarRowSchema),
});
export type FactionRankedWarsResponse = z.infer<typeof FactionRankedWarsResponseSchema>;

export const FactionMemberRowSchema = z.object({
  memberId: z.number(),
  name: z.string().nullable(),
  position: z.string().nullable(),
  daysInFaction: z.number().nullable(),
  isCurrentUser: z.boolean(),
  warAttacks: z.number(),
  warWins: z.number(),
  warRespect: z.number(),
  warMugs: z.number(),
  warHospitalizes: z.number(),
});
export type FactionMemberRow = z.infer<typeof FactionMemberRowSchema>;

export const FactionMembersResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  factionId: z.number().nullable(),
  members: z.array(FactionMemberRowSchema),
});
export type FactionMembersResponse = z.infer<typeof FactionMembersResponseSchema>;

export type FactionChainRow = z.infer<typeof FactionChainRowSchema>;

export const FactionChainRowSchema = z.object({
  chainId: z.number(),
  chain: z.number(),
  respect: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number(),
  durationSeconds: z.number(),
  myAttacks: z.number(),
  myRespect: z.number(),
});

export const FactionChainsResponseSchema = z.object({
  chains: z.array(FactionChainRowSchema),
});
export type FactionChainsResponse = z.infer<typeof FactionChainsResponseSchema>;

export const FactionOcRowSchema = z.object({
  ocId: z.number(),
  name: z.string(),
  status: z.string(),
  difficulty: z.number().nullable(),
  executedAt: z.number().nullable(),
  myParticipation: z.boolean(),
  rewardMoney: z.number().nullable(),
  rewardRespect: z.number().nullable(),
  payoutPercentage: z.number().nullable(),
});

export type FactionOcRow = z.infer<typeof FactionOcRowSchema>;

export const FactionOcsResponseSchema = z.object({
  ocs: z.array(FactionOcRowSchema),
  note: z.string().nullable(),
});
export type FactionOcsResponse = z.infer<typeof FactionOcsResponseSchema>;

export const FactionLedgerResponseSchema = z.object({
  snapshots: z.array(
    z.object({
      capturedAt: z.number(),
      money: z.number().nullable(),
      points: z.number().nullable(),
    })
  ),
  payouts: z.array(
    z.object({
      occurredAt: z.number(),
      amount: z.number(),
      description: z.string().nullable(),
      sourceRef: z.string(),
    })
  ),
});
export type FactionLedgerResponse = z.infer<typeof FactionLedgerResponseSchema>;

export const NetworthResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number(), interval: z.string() }),
  series: z.array(
    z.object({
      t: z.number(),
      total: z.number(),
      breakdown: z.object({
        cash: z.number(),
        banks: z.number(),
        points: z.number(),
        property: z.number(),
        stocks: z.number(),
        company: z.number(),
      }),
    })
  ),
  /** Legacy fixed-window changes (7d/30d/YTD/all) for the chart tooltips. */
  changes: z.object({
    current: z.number().nullable(),
    change7d: z.number().nullable(),
    change30d: z.number().nullable(),
    changeYtd: z.number().nullable(),
    changeAllTime: z.number().nullable(),
    firstTrackedAt: z.number().nullable(),
  }),
  /** Change over the SELECTED range with baseline + category breakdown. */
  period: z.object({
    currentAt: z.number().nullable(),
    current: z.number().nullable(),
    baselineAt: z.number().nullable(),
    baseline: z.number().nullable(),
    change: z.number().nullable(),
    changePct: z.number().nullable(),
    coverage: NetworthCoverageSchema,
    trackedFrom: z.number().nullable(),
    byCategory: z.array(NetworthCategoryChangeSchema),
  }),
  /** Earliest real snapshot across ALL history (independent of the range). */
  trackingSince: z.number().nullable(),
});
export type NetworthResponse = z.infer<typeof NetworthResponseSchema>;

export const MoneyEventDtoSchema = z.object({
  id: z.string(),
  occurredAt: z.number(),
  category: MoneyCategorySchema,
  subcategory: z.string().nullable(),
  direction: MoneyDirectionSchema,
  amount: z.number(),
  description: z.string().nullable(),
  source: z.string(),
  provenance: ProvenanceSchema,
});
export type MoneyEventDto = z.infer<typeof MoneyEventDtoSchema>;

export const DrugsSummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  overall: z.object({
    totalUses: z.number(),
    overdoses: z.number(),
    overdoseRate: z.number(),
    estimatedSpend: KpiValueSchema,
    averageCostPerUse: KpiValueSchema,
  }),
  byDrug: z.array(
    z.object({
      drug: z.string(),
      uses: z.number(),
      overdoses: z.number(),
      estimatedCost: z.number().nullable(),
      shareOfTotal: z.number(),
    })
  ),
  dailySeries: z.array(z.object({ t: z.number(), good: z.number(), bad: z.number() })),
  rehab: z.object({
    totalSpend: KpiValueSchema,
    trips: z.number(),
    latestAt: z.number().nullable(),
    averageSpend: KpiValueSchema,
    recent: z.array(
      z.object({
        occurredAt: z.number(),
        rehabPercent: z.number().nullable(),
        cost: z.number().nullable(),
      })
    ),
  }),
});
export type DrugsSummaryResponse = z.infer<typeof DrugsSummaryResponseSchema>;

export const DrugHistoryPointSchema = z.object({
  t: z.number(),
  good: z.number(),
  bad: z.number(),
  drugs: z.record(z.string(), z.number()),
});
export type DrugHistoryPoint = z.infer<typeof DrugHistoryPointSchema>;

export const TravelSummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  trips: z.number(),
  /**
   * Historical source coverage vs TornScope tracked history:
   * - trackingSince: earliest permanently stored travel evidence — trips
   *   never disappear when Torn prunes its logs
   * - sourceAvailableFrom: oldest travel log Torn still exposes (per the
   *   last backward walk) — reconstructions BEFORE this point are impossible
   */
  coverage: z.object({
    /** Earliest permanently stored travel evidence (tracking start). */
    trackingSince: z.number().nullable(),
    /** Earliest COMPLETE stored trip (depart + return both present). */
    completeTripsFrom: z.number().nullable(),
    /** Oldest travel log observed by the deepest backward walk so far. */
    sourceAvailableFrom: z.number().nullable(),
  }),
  estimatedProfit: KpiValueSchema,
  averageTripProfit: KpiValueSchema,
  profitPerHour: KpiValueSchema,
  topDestination: z.object({ destination: z.string().nullable(), profit: z.number().nullable() }),
  topItem: z.object({ item: z.string().nullable(), profit: z.number().nullable() }),
  profitSeries: z.array(z.object({ t: z.number(), profit: z.number() })),
  profitByDestination: z.array(
    z.object({ destination: z.string(), trips: z.number(), profit: z.number(), provenance: ProvenanceSchema })
  ),
  itemsByCategory: z.array(
    z.object({
      category: z.string(),
      quantity: z.number(),
      spend: z.number(),
      estimatedValue: z.number().nullable(),
    })
  ),
  /**
   * Abroad purchases whose trip could not be reconstructed (Torn keeps
   * travel-transition logs for a limited window, so the departure evidence
   * may predate collection). Their spend is real but not attributable to a
   * trip; provenance is incomplete by nature.
   */
  unattachedPurchases: z.object({
    count: z.number(),
    spend: z.number(),
    itemsBought: z.number(),
  }),
});
export type TravelSummaryResponse = z.infer<typeof TravelSummaryResponseSchema>;

export const TravelTripDtoSchema = z.object({
  id: z.string(),
  departedAt: z.number(),
  returnedAt: z.number().nullable(),
  destination: z.string(),
  durationSeconds: z.number().nullable(),
  itemsBought: z.number(),
  spend: z.number(),
  estimatedRevenue: z.number().nullable(),
  estimatedProfit: z.number().nullable(),
  profitPerHour: z.number().nullable(),
  provenance: ProvenanceSchema,
  items: z.array(
    z.object({
      id: z.string(),
      itemName: z.string(),
      category: z.string(),
      quantity: z.number(),
      unitCost: z.number(),
      totalCost: z.number(),
      estimatedUnitValue: z.number().nullable(),
      estimatedProfit: z.number().nullable(),
    })
  ),
});
export type TravelTripDto = z.infer<typeof TravelTripDtoSchema>;

export const TimelineEventDtoSchema = z.object({
  id: z.string(),
  occurredAt: z.number(),
  type: z.string(),
  category: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  amount: z.number().nullable(),
  source: z.string(),
  provenance: ProvenanceSchema,
});
export type TimelineEventDto = z.infer<typeof TimelineEventDtoSchema>;

export const SyncStatusResponseSchema = z.object({
  resources: z.array(
    z.object({
      resource: SyncResourceSchema,
      status: z.string(),
      lastAttemptAt: z.number().nullable(),
      lastSuccessAt: z.number().nullable(),
      nextRunAt: z.number().nullable(),
      recordsCollected: z.number(),
      errorMessage: z.string().nullable(),
    })
  ),
  running: z.boolean(),
});
export type SyncStatusResponse = z.infer<typeof SyncStatusResponseSchema>;

/** Full sync + system health for the Sync Status page. */
export const SyncHealthResponseSchema = z.object({
  running: z.boolean(),
  build: z.object({ commit: z.string() }),
  system: z.object({
    postgres: z.string(),
    redis: z.string(),
    worker: z.object({
      online: z.boolean(),
      lastHeartbeatAt: z.number().nullable(),
    }),
    tornApi: z.object({
      lastError: z.object({ resource: z.string(), message: z.string().nullable() }).nullable(),
    }),
  }),
  queues: z.object({
    sync: z.record(z.string(), z.number()).nullable(),
    scheduler: z.record(z.string(), z.number()).nullable(),
    note: z.string(),
  }),
  setupPhase: z.enum(["no_key", "queued", "syncing", "partial", "caught_up", "failed"]),
  /** Requested history window (worker config) coverage is judged against. */
  requestedHistoryDays: z.number(),
  resources: z.array(
    z.object({
      resource: SyncResourceSchema,
      status: z.string(),
      phase: z.enum(["queued", "running", "backfilling", "caught_up", "partial", "failed"]),
      lastAttemptAt: z.number().nullable(),
      lastSuccessAt: z.number().nullable(),
      nextRunAt: z.number().nullable(),
      lastTimestamp: z.number().nullable(),
      cursor: z.string().nullable(),
      recordsCollected: z.number(),
      errorCount: z.number(),
      errorMessage: z.string().nullable(),
      /**
       * Why the last historical (backward) walk stopped:
       * history_boundary_reached | source_exhausted | max_pages |
       * cursor_stalled | api_error | null (never walked).
       */
      stopReason: z.string().nullable(),
      /** Oldest source timestamp observed during the last backward walk. */
      sourceEarliestAt: z.number().nullable(),
      /** Torn API pages used by the last sync (incremental stays lightweight). */
      lastWalkPages: z.number().nullable(),
      /** Earliest/latest stored structured row for this resource's domain. */
      storedEarliestAt: z.number().nullable(),
      storedLatestAt: z.number().nullable(),
      /** Per-category cursor detail (walk resources; empty otherwise). */
      categories: z.array(
        z.object({
          categoryId: z.number(),
          title: z.string().nullable(),
          status: z.string(),
          lastTimestamp: z.number().nullable(),
          lastSuccessAt: z.number().nullable(),
          lastWalkPages: z.number().nullable(),
          lastRecordsInserted: z.number().nullable(),
          errorMessage: z.string().nullable(),
          lastActivityAt: z.number().nullable(),
          frequencySeconds: z.number().nullable(),
          nextRunAt: z.number().nullable(),
        })
      ),
      /** Adaptive schedule summary for the resource. */
      scheduleSummary: z.object({
        total: z.number(),
        due: z.number(),
        hot: z.number(),
        warm: z.number(),
        cold: z.number(),
        veryCold: z.number(),
        retry: z.number(),
        accessDenied: z.number(),
      }),
    })
  ),
});
export type SyncHealthResponse = z.infer<typeof SyncHealthResponseSchema>;

export const ApiKeyStatusResponseSchema = z.object({
  hasKey: z.boolean(),
  keyPreview: z.string().nullable(),
  accessLevel: z.string().nullable(),
  accessType: z.string().nullable(),
  validatedAt: z.number().nullable(),
  tornId: z.number().nullable(),
  tornName: z.string().nullable(),
  logAccessAvailable: z.boolean(),
});
export type ApiKeyStatusResponse = z.infer<typeof ApiKeyStatusResponseSchema>;

/** Predictable API error envelope. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorSchema>;
