import { z } from "zod";
import { MONEY_CATEGORIES, MONEY_DIRECTIONS, SYNC_RESOURCES } from "./torn.js";
import type { Provenance } from "./provenance.js";
import { SYNC_OPERATIONAL_STATES, SYNC_OPERATION_REASONS } from "./sync-health.js";
import { DataFreshnessEntrySchema } from "./freshness.js";

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
  // ≤ 2100-01-01: absurd epochs (1e300 etc.) must be a clean 400, never an
  // Invalid Date bubbling into a 500. from>to resolves to an empty window.
  from: z.coerce.number().int().positive().max(4102444800).optional(),
  to: z.coerce.number().int().positive().max(4102444800).optional(),
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
/* Data confidence (v0.2) — dataset-level trustworthiness                      */
/* -------------------------------------------------------------------------- */

export const DataConfidenceSchema = z.enum(["complete", "partial", "stale_permission", "unavailable"]);
export type DataConfidenceDto = z.infer<typeof DataConfidenceSchema>;

export const ConfidenceReasonSchema = z.enum([
  "missing_permission",
  "historical_permission_lost",
  "never_synced",
  "backfill_in_progress",
  "sync_incomplete",
  "sync_error",
  "range_before_coverage",
  "source_unavailable",
  "day_in_progress",
      "analysis_truncated",
]);
export type ConfidenceReasonDto = z.infer<typeof ConfidenceReasonSchema>;

/**
 * Known coverage window (unix seconds). Boundaries are exposed only when the
 * system truly knows them; hasKnownGaps is true only for provable gaps.
 */
export const ConfidenceCoverageSchema = z.object({
  from: z.number().nullable(),
  to: z.number().nullable(),
  hasKnownGaps: z.boolean(),
});
export type ConfidenceCoverageDto = z.infer<typeof ConfidenceCoverageSchema>;

/**
 * Dataset-level confidence metadata, derived centrally from real system
 * state (capabilities + sync state + coverage). Compact by design: one block
 * per dataset, never per numeric field. See docs/DATA-CONFIDENCE.md.
 */
export const DataConfidenceMetaSchema = z.object({
  confidence: DataConfidenceSchema,
  /** Machine-readable why-code; the UI maps it to localized copy. */
  reason: ConfidenceReasonSchema.nullable(),
  /** Backing resource's last successful refresh (unix seconds). */
  lastRefreshedAt: z.number().nullable(),
  coverage: ConfidenceCoverageSchema,
});
export type DataConfidenceMetaDto = z.infer<typeof DataConfidenceMetaSchema>;

/* -------------------------------------------------------------------------- */
/* API response contracts                                                     */
/* -------------------------------------------------------------------------- */

export const MoneyCategorySchema = z.enum(MONEY_CATEGORIES);
export const MoneyDirectionSchema = z.enum(MONEY_DIRECTIONS);
export const SyncResourceSchema = z.enum(SYNC_RESOURCES);

export const KeyCapabilitiesSchema = z.object({
  canReadUserBasic: z.boolean(),
  canReadUserMerits: z.boolean(),
  canReadUserStocks: z.boolean(),
  canReadUserBars: z.boolean(),
  canReadUserCooldowns: z.boolean(),
  canReadUserEducation: z.boolean(),
  canReadUserTravel: z.boolean(),
  canReadUserMoney: z.boolean(),
  canReadUserLogs: z.boolean(),
  canReadUserAttacks: z.boolean(),
  canReadUserNetworth: z.boolean(),
  canReadUserEvents: z.boolean(),
  canReadUserPersonalStats: z.boolean(),
  canReadFactionBasic: z.boolean(),
  canReadFactionMembers: z.boolean(),
  canReadFactionRankedWars: z.boolean(),
  canReadFactionChains: z.boolean(),
  canReadFactionCrimes: z.boolean(),
  canReadFactionArmoryNews: z.boolean(),
  canReadFactionBalance: z.boolean(),
  canReadFactionLogs: z.boolean(),
});
export type KeyCapabilitiesDto = z.infer<typeof KeyCapabilitiesSchema>;

/** Honest per-feature data state (permission vs source; live vs stale). */
export const FeatureAvailabilitySchema = z.object({
  state: z.enum(["available_live", "available_historical", "partial", "stale_permission", "unavailable_permission", "unavailable_source"]),
  /** Friendly name of the missing permission (null when not permission-caused). */
  requiresLabel: z.string().nullable(),
  /** Technical Torn selections to grant (details view). */
  requiresSelections: z.array(z.string()),
  /** Previously collected history still exists for this feature. */
  hasHistoricalData: z.boolean(),
  lastRefreshedAt: z.number().nullable(),
});
export type FeatureAvailabilityDto = z.infer<typeof FeatureAvailabilitySchema>;

/** Result of validating a key WITHOUT storing it (replace-key preview flow). */
export const ApiKeyValidationResponseSchema = z.object({
  valid: z.boolean(),
  tornId: z.number().nullable(),
  tornName: z.string().nullable(),
  accessLevel: z.number().nullable(),
  accessType: z.string().nullable(),
  capabilities: KeyCapabilitiesSchema.nullable(),
  /** Old -> new comparison against the currently stored key (null without one). */
  capabilityChange: z
    .object({ newlyAvailable: z.array(z.string()), newlyUnavailable: z.array(z.string()) })
    .nullable(),
  /** True when the new key grants strictly fewer detected capabilities. */
  downgrade: z.boolean(),
  /** True when the new key grants capabilities the stored one lacks. */
  upgrade: z.boolean(),
});
export type ApiKeyValidationResponse = z.infer<typeof ApiKeyValidationResponseSchema>;

/**
 * An existing TornScope profile for the same Torn identity (profile-reuse
 * flow). Returned when a NEW browser validates a key whose Torn ID already
 * has a non-demo profile — the browser then chooses to link or replace.
 */
export const ExistingProfileInfoSchema = z.object({
  tornId: z.number(),
  name: z.string().nullable(),
  level: z.number().nullable(),
  factionName: z.string().nullable(),
  /** The access level stored on that profile (Full/Limited/...). */
  storedAccess: z.object({ level: z.number().nullable(), type: z.string().nullable() }).nullable(),
  history: z.object({
    earliestAt: z.number().nullable(),
    timelineEvents: z.number(),
    moneyEvents: z.number(),
    drugEvents: z.number(),
    crimeEvents: z.number(),
    combatEvents: z.number(),
    travelTrips: z.number(),
  }),
});
export type ExistingProfileInfo = z.infer<typeof ExistingProfileInfoSchema>;

/** Result of linking the current browser session to an existing profile. */
export const ProfileLinkResultSchema = z.object({
  linked: z.boolean(),
  /** True when the session was already bound to this profile (idempotent). */
  alreadyLinked: z.boolean(),
  profile: ExistingProfileInfoSchema.nullable(),
  /** Explicit note: linking never changes the stored API key. */
  storedKeyUntouched: z.boolean(),
});
export type ProfileLinkResult = z.infer<typeof ProfileLinkResultSchema>;

export const MeResponseSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  /** IANA timezone used for rendering human-readable times (default UTC). */
  timezone: z.string(),
  isDemo: z.boolean(),
  /** 2.0.5 heads-up pre-alert thresholds (minutes; profile-level, from
   *  NotificationPreference.typeConfig with defaults filled in). */
  headsUp: z.object({
    travelPreMin: z.number(),
    drugPreMin: z.number(),
    boosterPreMin: z.number(),
    medicalPreMin: z.number(),
    ocPreMin: z.number(),
    bankPreMin: z.number(),
  }),
  /** Detected key capabilities (null while no key is connected). */
  capabilities: KeyCapabilitiesSchema.nullable(),
  /** Torn's own access description for the stored key (e.g. "Full Access"). */
  accessType: z.string().nullable(),
  /** Numeric Torn access level (1=Public … 4=Full) when known. */
  accessLevel: z.number().nullable(),
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
  /** Number of active (non-revoked) browser sessions on THIS profile. */
  activeSessions: z.number(),
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
  /**
   * Wealth Torn does NOT count in its official net worth figure. Currently
   * one component: the withdrawable faction member balance. Always rendered
   * separately — never silently merged into netWorth.
   */
  extendedWealth: z.object({
    /** official net worth + all extended components (null without netWorth). */
    value: z.number().nullable(),
    /** Withdrawable faction member balance (the owner's own row). */
    factionBalance: z.number().nullable(),
    factionBalanceCapturedAt: z.number().nullable(),
  }),
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
      /** Wins across BOTH directions (outgoing wins + successful defenses). */
      wins: z.number(),
      outgoingWins: z.number(),
      /** Incoming attacks the player successfully defended. */
      incomingDefended: z.number(),
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
  /**
   * Economic semantics over the selected range. Cash inflow/outflow include
   * asset conversions; earned vs asset splits make it impossible to read
   * bazaar sales as profit.
   */
  financial: z.object({
    /** All cash that entered the wallet (earned + asset sales). */
    cashInflow: KpiValueSchema,
    /** All cash that left the wallet (true expenses + asset purchases). */
    cashOutflow: KpiValueSchema,
    /** Earned/received money — raises total economic value directly. */
    trueIncome: z.number(),
    /** Spent/lost money — lowers total economic value directly. */
    trueExpense: z.number(),
    /** Cash received from selling assets (items, points, stocks). */
    assetSales: z.number(),
    /** Cash spent acquiring assets (still owned in another form). */
    assetPurchases: z.number(),
    /** Unclassified cash magnitude (never silently zero). */
    unknownValue: z.number(),
    /** Internal movements between owned accounts (bank invest/withdraw). */
    bankTransfers: z.number(),
    /**
     * Receiving-side breakdown: earned income vs asset sales vs other, with
     * explicit labels ("Item Market sales", never a bare "Items"). Rows
     * reconcile EXACTLY to cashInflow.value; no event is counted twice.
     */
    cashReceived: z
      .object({
        total: z.number(),
        earned: z.object({
          total: z.number(),
          /** OC payouts — earned, but credited to the faction member balance. */
          ocPayouts: z.number(),
          rows: z.array(z.object({ key: z.string(), label: z.string(), amount: z.number() })),
        }),
        assetSales: z.object({
          total: z.number(),
          rows: z.array(z.object({ key: z.string(), label: z.string(), amount: z.number() })),
        }),
        other: z.object({
          total: z.number(),
          rows: z.array(z.object({ key: z.string(), label: z.string(), amount: z.number() })),
        }),
        unclassified: z.object({ total: z.number(), count: z.number() }),
      })
      .nullable(),
    /**
     * Net worth snapshot delta over the range. This is a SNAPSHOT DELTA —
     * it includes item/stock/property price moves, cash and asset movement —
     * and is never labeled profit or economic gain.
     */
    economicGain: KpiValueSchema,
    /** Snapshot timestamps the delta is measured between (unix seconds, null = n/a). */
    netWorthMeasuredFrom: z.number().nullable(),
    netWorthMeasuredTo: z.number().nullable(),
  }),
  /**
   * Wallet cash reconciliation: where actual wallet cash came from and went
   * during the range. Wallet semantics (cash movement) are distinct from
   * economic semantics (value change): a bank investment empties the wallet
   * without being an expense.
   */
  wallet: z.object({
    startingCash: z.number().nullable(),
    actualEndingCash: z.number().nullable(),
    expectedEndingCash: z.number().nullable(),
    /** All cash that entered the wallet (income rows + withdrawals). */
    walletInflow: z.number(),
    /** All cash that left the wallet (spending + bank investments). */
    walletOutflow: z.number(),
    bankDeposits: z.number(),
    bankWithdrawals: z.number(),
    /**
     * Value paid into the FACTION MEMBER BALANCE in this range (OC payouts).
     * Never wallet cash — excluded from inflow/outflow above; the money is
     * still owned and shows up in Extended Wealth via the faction balance.
     */
    factionBalanceCredits: z.number(),
    unreconciled: z.number().nullable(),
    coverage: z.enum(["full", "partial", "unavailable"]),
    startingSnapshotAt: z.number().nullable(),
    endingSnapshotAt: z.number().nullable(),
  }),
  /**
   * One concise Progression glimpse (training gain + energy trained over the
   * selected range). Null figures when the backing history does not exist —
   * never zero-filled. The full analysis lives on /progression.
   */
  progression: z.object({
    battlestatGain: KpiValueSchema,
    energyTrained: KpiValueSchema,
  }),
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
  /**
   * Dataset-level confidence for the Overview cards where unavailable-vs-zero
   * matters (v0.2). Derived centrally; the UI renders badges/tooltips from it.
   */
  confidence: z.object({
    cashFlow: DataConfidenceMetaSchema,
    drugs: DataConfidenceMetaSchema,
    travelProfit: DataConfidenceMetaSchema,
    rehab: DataConfidenceMetaSchema,
    networth: DataConfidenceMetaSchema,
  }),
});
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

export const MoneySummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number(), interval: z.string() }),
  availability: z.object({ cashFlow: FeatureAvailabilitySchema }).optional(),
  totalIncome: KpiValueSchema,
  totalExpenses: KpiValueSchema,
  netProfit: KpiValueSchema,
  largestIncomeCategory: z.object({ category: MoneyCategorySchema.nullable(), total: z.number().nullable() }),
  largestExpenseCategory: z.object({ category: MoneyCategorySchema.nullable(), total: z.number().nullable() }),
  incomeByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
  expensesByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
  flowSeries: z.array(z.object({ t: z.number(), income: z.number(), expenses: z.number() })),
  cumulativeNetSeries: z.array(z.object({ t: z.number(), net: z.number() })),
  /** True when the range held more events than the analysis cap — the
   *  aggregates cover the earliest events and are explicitly partial. */
  analysisTruncated: z.boolean().optional(),
});
export type MoneySummaryResponse = z.infer<typeof MoneySummaryResponseSchema>;

/**
 * Quality of the wallet cash reconciliation (roadmap #6). Anchors missing →
 * unavailable; known money-log coverage gaps cap at partial; sub-dollar
 * residual → exact; a tiny fraction of recorded flow → small_residual;
 * anything larger → unreconciled. Never hidden, never rendered as zero.
 */
export const ReconciliationQualitySchema = z.enum(["exact", "small_residual", "partial", "unreconciled", "unavailable"]);
export type ReconciliationQuality = z.infer<typeof ReconciliationQualitySchema>;

/** Semantic role of one ledger row (the canonical economy vocabulary). */
export const MovementRoleSchema = z.enum(["income", "expense", "conversion_in", "conversion_out", "transfer"]);
export type MovementRole = z.infer<typeof MovementRoleSchema>;

/**
 * Economy view: clearly separated financial lenses.
 * - Cash Flow: ONLY real cash movements (purchases, sales, fees, payouts).
 * - Economic Effect: true income/expense — value gained or lost, conversions
 *   excluded, derived bank interest included.
 * - Conversions: cash ↔ asset exchanges (bank, stocks, items, points, vault).
 * - Consumption: value of items used up — never added to the cash P&L.
 * - Wallet: reconciliation of opening cash → recorded movements → actual.
 * - Networth: Torn snapshot totals and their change over the period.
 * - Explanation: deterministic contributors + what remains unexplained.
 * The lenses are related, NOT additive — cash net + economic net +
 * conversion net does not equal net worth change.
 * Plus the estimated travel profit, kept separate from all of the above.
 */
export const EconomySummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number(), interval: z.string() }),
  /** Unix seconds when this payload was computed. */
  generatedAt: z.number(),
  availability: z
    .object({
      cashFlow: FeatureAvailabilitySchema,
      walletBridge: FeatureAvailabilitySchema,
      networth: FeatureAvailabilitySchema,
    })
    .optional(),
  cashFlow: z.object({
    income: KpiValueSchema,
    expenses: KpiValueSchema,
    netCashFlow: KpiValueSchema,
    /** Unclassified money rows in range — value may still change. */
    unclassifiedCount: z.number(),
    incomeByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
    expensesByCategory: z.array(z.object({ category: MoneyCategorySchema, total: z.number() })),
    /** Earned money (raises total value) vs asset-sale proceeds (conversion). */
    trueIncome: z.number(),
    trueExpense: z.number(),
    assetInflow: z.number(),
    assetOutflow: z.number(),
  }),
  /**
   * True income vs expense (economic effect). Bank interest is DERIVED from
   * invest/withdraw pairs and included here; principal returns are not.
   * This is the closest figure to profit/loss — never labeled as such,
   * because acquisition cost bases remain unknown.
   */
  economicEffect: z.object({
    income: KpiValueSchema,
    expenses: KpiValueSchema,
    net: KpiValueSchema,
    /** Derived bank interest inside income. */
    interestIncome: z.number(),
    /** false when some withdrawal's principal/interest split is unattributable. */
    interestComplete: z.boolean(),
    incomeCategories: z.array(z.object({ key: z.string(), label: z.string(), total: z.number(), provenance: ProvenanceSchema })),
    expenseCategories: z.array(z.object({ key: z.string(), label: z.string(), total: z.number(), provenance: ProvenanceSchema })),
    confidence: DataConfidenceMetaSchema,
  }),
  /**
   * Cash exchanged for assets and vice versa. Conversions are NOT income or
   * expense: value changes form, it is not gained or lost.
   */
  conversions: z.object({
    cashIntoAssets: KpiValueSchema,
    assetsIntoCash: KpiValueSchema,
    /** assetsIntoCash − cashIntoAssets (cash released / absorbed by assets). */
    netCashEffect: KpiValueSchema,
    /** Bank-account subset of the conversion volume (both directions). */
    bankTransfers: z.number(),
    byPair: z.array(z.object({ pair: z.string(), label: z.string(), amount: z.number(), count: z.number() })),
    confidence: DataConfidenceMetaSchema,
  }),
  /**
   * Wallet cash reconciliation over the range: opening wallet + recorded
   * inflows − recorded outflows = expected closing, compared against the
   * actual closing wallet from networth snapshots. The residual is always
   * surfaced, never hidden and never zero-filled.
   */
  wallet: z.object({
    openingWallet: z.number().nullable(),
    closingWallet: z.number().nullable(),
    expectedClosingWallet: z.number().nullable(),
    recordedInflows: z.number(),
    recordedOutflows: z.number(),
    recordedNet: z.number(),
    /** actualClosing − expectedClosing; null without both anchors. */
    residual: z.number().nullable(),
    quality: ReconciliationQualitySchema,
    /** 0..1 share of the wallet change explained by recorded movements. */
    explainedRatio: z.number().nullable(),
    openingSnapshotAt: z.number().nullable(),
    closingSnapshotAt: z.number().nullable(),
    /** OC payouts credited to the faction balance (excluded from flows above). */
    factionBalanceCredits: z.number(),
    /** worst of money_logs + networth confidence (both anchor the bridge). */
    confidence: DataConfidenceMetaSchema,
  }),
  /**
   * Why did net worth move? Official snapshot category deltas (recorded),
   * estimated economic effects (travel, consumption) and the residual that
   * recorded activity does not explain. Related, not additive.
   */
  explanation: z.object({
    contributors: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        value: z.number().nullable(),
        provenance: ProvenanceSchema,
        certainty: z.enum(["recorded", "estimated", "unexplained"]),
        source: z.string(),
      })
    ),
    /** Wallet reconciliation residual (same figure as wallet.residual). */
    walletUnexplained: z.number().nullable(),
    /** Net worth delta not explained by recorded + estimated activity. */
    netWorthUnexplained: z.number().nullable(),
    quality: ReconciliationQualitySchema,
  }),
  /** Largest meaningful movements across all semantic roles, largest first. */
  majorMovements: z.array(
    z.object({
      id: z.string(),
      occurredAt: z.number(),
      category: z.string(),
      label: z.string(),
      description: z.string().nullable(),
      role: MovementRoleSchema,
      /** Magnitude (always positive). */
      amount: z.number(),
    })
  ),
  /** Bucketed series for the Economy charts (same range as everything else). */
  series: z.object({
    flow: z.array(z.object({ t: z.number(), income: z.number(), expenses: z.number() })),
    cumulativeNet: z.array(z.object({ t: z.number(), net: z.number() })),
  }),
  /** Item sales: cash received vs estimated market value of items removed. */
  sales: z.object({
    /** Cash received from bazaar / item market / trading / auction sales. */
    cashReceived: z.number(),
    /** Catalog market value of identified sold items (null when no item data). */
    inventoryValueRemoved: z.number().nullable(),
    /** cashReceived − inventoryValueRemoved; null when valuation unavailable. */
    economicResult: z.number().nullable(),
    provenance: z.enum(["estimated", "unavailable"]),
  }),
  /** Wealth gained without cash movement (crime/OC item rewards, est.). */
  nonCashGains: z.object({
    value: z.number().nullable(),
    provenance: z.enum(["estimated", "unavailable"]),
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
  /** Dataset-level confidence for the Economy cards (v0.2, see DATA-CONFIDENCE.md). */
  confidence: z.object({
    cashFlow: DataConfidenceMetaSchema,
    consumption: DataConfidenceMetaSchema,
    networth: DataConfidenceMetaSchema,
    travel: DataConfidenceMetaSchema,
  }),
  /** 2.0 economy intelligence — wealth velocity, trend projection, attribution and personal records (all derived from stored data). */
  intelligence: z.object({
    velocity: z.array(
      z.object({
        lookbackDays: z.number(),
        change: z.number().nullable(),
        velocityPerDay: z.number().nullable(),
        coverage: z.enum(["full", "partial", "none"]),
        trend: z.object({
          velocityPerDay: z.number().nullable(),
          slopePerDay: z.number().nullable(),
          fitR2: z.number().nullable(),
          confidence: z.enum(["high", "medium", "low", "insufficient"]),
          window: z.object({ from: z.number().nullable(), to: z.number().nullable(), points: z.number(), spanDays: z.number().nullable() }),
        }),
      })
    ),
    projection: z.object({
      current: z.number().nullable(),
      projectedIn30d: z.number().nullable(),
      velocityPerDay: z.number().nullable(),
      confidence: z.enum(["high", "medium", "low", "insufficient"]),
      lookbackDays: z.number(),
      horizonDays: z.number(),
      provenance: z.literal("derived"),
    }),
    attribution: z.object({
      from: z.number(),
      to: z.number(),
      earnedIncome: z.number(),
      spending: z.number(),
      assetSales: z.number(),
      assetPurchases: z.number(),
      netWorthChange: z.number().nullable(),
      unexplainedMovement: z.number().nullable(),
      netWorthCoverage: z.enum(["full", "partial", "none"]),
      unknownShare: z.number(),
      provenance: z.literal("derived"),
    }),
    records: z.object({
      highestNetWorth: z.object({ value: z.number(), at: z.number(), provenance: z.enum(["exact", "estimated"]) }).nullable(),
      highestWalletBalance: z.object({ value: z.number(), at: z.number(), provenance: z.enum(["exact", "estimated"]) }).nullable(),
      bestIncomeDay: z.object({ value: z.number(), at: z.number(), provenance: z.enum(["exact", "estimated"]) }).nullable(),
      largestExpenseDay: z.object({ value: z.number(), at: z.number(), provenance: z.enum(["exact", "estimated"]) }).nullable(),
      highestDailyWealthGrowth: z.object({ value: z.number(), at: z.number(), provenance: z.enum(["exact", "estimated"]) }).nullable(),
      mostProfitableTravelDay: z.object({ value: z.number(), at: z.number(), provenance: z.enum(["exact", "estimated"]) }).nullable(),
    }),
  }),
});
export type EconomySummaryResponse = z.infer<typeof EconomySummaryResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Daily Summary (v0.2 item #2)                                                */
/* -------------------------------------------------------------------------- */

/** A canonical-labeled category contribution (compact, top-N only). */
export const SummaryCategoryRowSchema = z.object({
  category: z.string(),
  /** Canonical human label from the shared label maps (never raw slugs). */
  label: z.string(),
  total: z.number(),
});
export type SummaryCategoryRow = z.infer<typeof SummaryCategoryRowSchema>;

/**
 * Deterministic highlight kinds. The UI maps kind + canonical label to
 * localized sentences; the server never ships long prose, and hedged causal
 * wording ("contributed", "recorded movement") lives ONLY on the frontend.
 */
export const DailyHighlightKindSchema = z.enum([
  "large_cash_in",
  "large_cash_out",
  "asset_conversion",
  "networth_move",
  "travel_profit",
  "drug_use",
  "rehab",
  "bank_transfer",
  "combat",
  "crime",
  "account_event",
  "quiet_day",
]);
export type DailyHighlightKind = z.infer<typeof DailyHighlightKindSchema>;

export const DailyHighlightSchema = z.object({
  kind: DailyHighlightKindSchema,
  /** Short canonical noun phrase (e.g. "Bazaar", "City Bank", "Rehab"). */
  label: z.string(),
  /** Signed magnitude when known; null never renders as 0. */
  amount: z.number().nullable(),
  occurredAt: z.number().nullable(),
  tone: z.enum(["neutral", "positive", "negative", "accent"]),
});
export type DailyHighlight = z.infer<typeof DailyHighlightSchema>;

/**
 * "Why did net worth move?" — the EXACT category reconciliation. Category
 * deltas partition the snapshot change precisely, so the list sums to the
 * day's delta; the frontend must present it as a reconciliation, not a
 * causal story. `residual` with certainty "unexplained" appears only when a
 * structural gap is detected (expected: never).
 */
export const NetworthDriverSchema = z.object({
  kind: z.enum(["cash_flow", "inventory_move", "bank_move", "consumption", "travel_profit", "residual"]),
  label: z.string(),
  /** Signed estimated contribution where derivable; null when unknown. */
  magnitude: z.number().nullable(),
  certainty: z.enum(["recorded", "estimated", "unexplained"]),
});
export type NetworthDriver = z.infer<typeof NetworthDriverSchema>;

/**
 * One day's account summary, in the user's timezone. Every section carries
 * its own DataConfidenceMeta from the central derivation; overallConfidence
 * is the worst of the critical sections (money_logs, networth, drugs, travel),
 * capped at partial while the day is still ongoing.
 */
export const DailySummaryResponseSchema = z.object({
  /** "YYYY-MM-DD" — the calendar day in the user's timezone. */
  date: z.string(),
  timezone: z.string(),
  range: z.object({ from: z.number(), to: z.number() }),
  generatedAt: z.number(),
  /** True while the requested day has not ended in the timezone. */
  ongoingDay: z.boolean(),

  netWorth: z.object({
    start: z.number().nullable(),
    startAt: z.number().nullable(),
    end: z.number().nullable(),
    endAt: z.number().nullable(),
    /** Official Torn snapshot delta — never labeled profit. */
    delta: z.number().nullable(),
    changePct: z.number().nullable(),
    coverage: NetworthCoverageSchema,
    drivers: z.array(NetworthDriverSchema).nullable(),
    /** Activity flows behind the category moves (recorded net cash flow,
     *  consumed value, travel profit). Annotations only — NOT part of the
     *  driver reconciliation, which sums to the delta exactly. */
    activity: z.array(NetworthDriverSchema).optional(),
    confidence: DataConfidenceMetaSchema,
    /**
     * Inspectable wallet equation behind the Cash driver row (real-user
     * finding: "why did cash move by this amount?"). opening + knownReceived
     * − knownSpent = expectedClosing, compared against actualClosing, with
     * the graded residual. quality: exact | small_residual | partial |
     * unreconciled | unavailable — "partial" also covers known money-log
     * coverage gaps, so a day is never presented as fully explained when the
     * history is not proven complete. Optional for deploy-order tolerance.
     */
    wallet: z
      .object({
        opening: z.number().nullable(),
        openingAt: z.number().nullable(),
        knownReceived: z.number(),
        knownSpent: z.number(),
        expectedClosing: z.number().nullable(),
        actualClosing: z.number().nullable(),
        residual: z.number().nullable(),
        coverage: z.enum(["full", "partial", "unavailable"]),
        quality: z.enum(["exact", "small_residual", "partial", "unreconciled", "unavailable"]),
      })
      .optional(),
  }),
  cashFlow: z.object({
    received: KpiValueSchema,
    spent: KpiValueSchema,
    net: KpiValueSchema,
    topInflow: z.array(SummaryCategoryRowSchema),
    topOutflow: z.array(SummaryCategoryRowSchema),
    confidence: DataConfidenceMetaSchema,
  }),
  economicEffect: z.object({
    trueIncome: KpiValueSchema,
    trueExpense: KpiValueSchema,
    net: KpiValueSchema,
    confidence: DataConfidenceMetaSchema,
  }),
  assetConversions: z.object({
    /** Assets → cash (sales). Not income. */
    convertedIn: KpiValueSchema,
    /** Cash → assets (purchases, bank deposits, point buys). Not spending. */
    convertedOut: KpiValueSchema,
    /** Internal movements between owned accounts (bank invest/withdraw). */
    bankTransfers: z.number(),
    rows: z.array(SummaryCategoryRowSchema),
    confidence: DataConfidenceMetaSchema,
  }),
  travel: z.object({
    trips: z.number(),
    estimatedProfit: KpiValueSchema,
    confidence: DataConfidenceMetaSchema,
  }),
  drugs: z.object({
    uses: z.number(),
    estimatedConsumptionValue: KpiValueSchema,
    valueUnknownCount: z.number(),
    xanax: z.object({
      consumed: z.number(),
      confirmedPersonal: z.number(),
      confirmedFaction: z.number(),
      confirmedOther: z.number(),
      openingInventoryUnknown: z.number(),
      unknown: z.number(),
      /** Catalog-estimated value of the day's Xanax (null without prices). */
      estimatedValue: z.number().nullable(),
    }),
    confidence: DataConfidenceMetaSchema,
  }),
  rehab: z.object({
    /** One raw rehab row = one visit. */
    visits: z.number(),
    /** Known cost sum; incomplete availability when any visit cost is unknown. */
    cost: KpiValueSchema,
    sessionsUnavailable: z.number(),
    confidence: DataConfidenceMetaSchema,
  }),
  highlights: z.array(DailyHighlightSchema),
  /**
   * Compact Progression glimpse (roadmap: Progression & Energy Intelligence).
   * Battlestat gain is derived from hourly stat snapshots; training energy is
   * an inference from bar history — null when that history does not exist.
   * gymGain is the gym-ATTRIBUTABLE share of that gain (exact job/company
   * stat points netted out; friend-train amounts cannot be separated and
   * keep attribution provisional) — the only figure a training surface may
   * present as a training gain. Optional for deploy-order tolerance:
   * consumers must fall back to battlestatGain (TOTAL stat change) with
   * clearly different wording.
   */
  progression: z
    .object({
      battlestatGain: KpiValueSchema,
      gymGain: KpiValueSchema.optional(),
      energyTrained: KpiValueSchema,
      sessions: z.number(),
      confidence: DataConfidenceMetaSchema,
    })
    .nullable(),
  overallConfidence: DataConfidenceMetaSchema,
});
export type DailySummaryResponse = z.infer<typeof DailySummaryResponseSchema>;

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
  availability: z.object({ history: FeatureAvailabilitySchema }).optional(),
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
  availability: z.object({ history: FeatureAvailabilitySchema }).optional(),
  attacksMade: z.number(),
  attacksReceived: z.number(),
  wins: z.number(),
  losses: z.number(),
  winRate: z.number().nullable(),
  /** Outgoing attacks I won (attacker results: Attacked/Mugged/Hospitalized/...). */
  outgoingWins: z.number(),
  /** Outgoing attacks I lost (result "Lost"). */
  outgoingLosses: z.number(),
  /** Incoming attacks I successfully defended (result "Defended"). */
  incomingDefended: z.number(),
  /** Incoming attacks where the attacker won (I lost the encounter). */
  incomingLost: z.number(),
  mugsMade: z.number(),
  mugsReceived: z.number(),
  moneyMugged: KpiValueSchema,
  moneyLostToMugs: KpiValueSchema,
  hospitalizationsCaused: z.number(),
  hospitalizationsReceived: z.number(),
  respectGained: z.number().nullable(),
  respectLost: z.number().nullable(),
  byOpponent: z.array(OpponentRowSchema),
  dailySeries: z.array(
    z.object({
      t: z.number(),
      made: z.number(),
      received: z.number(),
      wins: z.number(),
      losses: z.number(),
      outgoingWins: z.number(),
      outgoingLosses: z.number(),
      incomingDefended: z.number(),
      incomingLost: z.number(),
    })
  ),
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

export type WarStatProvenance = "exact_from_war_api" | "derived_from_attacks" | "unavailable";

export const FactionWarMemberRowSchema = z.object({
  tornId: z.number().nullable(),
  name: z.string().nullable(),
  warId: z.number(),
  attacks: z.number(),
  wins: z.number(),
  losses: z.number(),
  respect: z.number(),
  mugs: z.number(),
  hospitalizes: z.number(),
  payout: z.number().nullable(),
  provenance: z.enum(["exact_from_war_api", "derived_from_attacks", "unavailable"]),
});
export type FactionWarMemberRow = z.infer<typeof FactionWarMemberRowSchema>;

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
  availability: z
    .object({
      basic: FeatureAvailabilitySchema,
      members: FeatureAvailabilitySchema,
      rankedWars: FeatureAvailabilitySchema,
      organizedCrimes: FeatureAvailabilitySchema,
      armoryHistory: FeatureAvailabilitySchema,
      balance: FeatureAvailabilitySchema,
    })
    .optional(),
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
  /** Newest first — lets Overview show real war history without the wars tab. */
  recentWars: z.array(
    z.object({
      tornWarId: z.number(),
      opponentName: z.string().nullable(),
      startedAt: z.number(),
      endedAt: z.number().nullable(),
      result: z.enum(["win", "loss", "ongoing", "draw"]),
      ourScore: z.number().nullable(),
      opponentScore: z.number().nullable(),
    })
  ),
  payouts: z.object({
    /** Faction income rows actually matched to a ranked war (conservative). */
    knownTotal: z.number(),
    personalTotal: z.number(),
    /** Faction income rows carrying OC scenario metadata (exact OC payouts). */
    ocTotal: z.number(),
    /** Faction income rows with no war or OC linkage. */
    unmatchedTotal: z.number(),
  }),
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
  level: z.number().nullable(),
  daysInFaction: z.number().nullable(),
  /** Live-ish status from the roster (e.g. "Okay" / "Hospital") when known. */
  status: z.string().nullable(),
  lastActionAt: z.number().nullable(),
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

export const FactionOcParticipantSchema = z.object({
  memberId: z.number().nullable(),
  memberName: z.string().nullable(),
  position: z.string().nullable(),
  outcome: z.string().nullable(),
  progress: z.number().nullable(),
  checkpointPassRate: z.number().nullable(),
  isOwner: z.boolean(),
});
export type FactionOcParticipant = z.infer<typeof FactionOcParticipantSchema>;

export const FactionOcRowSchema = z.object({
  ocId: z.number(),
  name: z.string(),
  status: z.string(),
  /** Grouped lifecycle state derived from the Torn status string. */
  state: z.enum(["active", "completed", "expired"]),
  difficulty: z.number().nullable(),
  /**
   * OC tier — Torn's difficulty rating is the tier number players refer to.
   * Null when Torn provides no tier/difficulty for this OC (never guessed).
   */
  tier: z.number().nullable(),
  executedAt: z.number().nullable(),
  /** Planning/start times where Torn provides them (unix seconds). */
  planningAt: z.number().nullable(),
  readyAt: z.number().nullable(),
  /** Slots positively filled (participant present) out of total slots. */
  slotsFilled: z.number(),
  slotsTotal: z.number(),
  myParticipation: z.boolean(),
  /** The user's slot position in this OC, when positively participating. */
  myPosition: z.string().nullable(),
  /** False when the stored payload carries no participant ids ("Mine" = Unavailable). */
  participantsIdentifiable: z.boolean(),
  rewardMoney: z.number().nullable(),
  rewardRespect: z.number().nullable(),
  rewardItems: z.array(z.object({ id: z.number(), quantity: z.number() })).nullable(),
  /** Reward items resolved to names/kinds with per-item estimated values. */
  rewardItemsDetailed: z.array(
    z.object({
      itemId: z.number(),
      name: z.string(),
      quantity: z.number(),
      kind: z.enum(["drug", "weapon", "vehicle", "armor", "other"]),
      estimatedUnitValue: z.number().nullable(),
      estimatedValue: z.number().nullable(),
    })
  ),
  /**
   * Cash (Torn-reported) + estimated catalog value of priced reward items.
   * Null when the OC carries no item rewards; unpriced items are excluded
   * from the total and flagged by rewardValueComplete.
   */
  rewardEstimatedTotal: z.number().nullable(),
  /** False when some reward item has no catalog price (total is partial). */
  rewardValueComplete: z.boolean(),
  payoutPercentage: z.number().nullable(),
  paidBy: z.number().nullable(),
  paidAt: z.number().nullable(),
  payoutType: z.string().nullable(),
  participants: z.array(FactionOcParticipantSchema),
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
        /** "oc" = exact OC scenario linkage; "unmatched" = unknown origin. */
        kind: z.enum(["oc", "unmatched"]),
        scenario: z.string().nullable(),
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
  availability: z
    .object({
      cooldown: FeatureAvailabilitySchema,
      history: FeatureAvailabilitySchema,
      xanaxProvenance: FeatureAvailabilitySchema,
    })
    .optional(),
  overall: z.object({
    totalUses: z.number(),
    overdoses: z.number(),
    overdoseRate: z.number(),
    estimatedSpend: KpiValueSchema,
    averageCostPerUse: KpiValueSchema,
    /** Average Xanax uses per COVERED day in the selected range. */
    xanaxPerDay: z.number().nullable(),
    /** Days actually covered by drug data inside the range (partial coverage < range length). */
    coveredDays: z.number().nullable(),
    coverage: z.enum(["full", "partial", "unavailable"]),
    /**
     * 2.1.0: good-streak accounting over the SELECTED range's events
     * (current run since the last in-range overdose + longest run).
     */
    streaks: z
      .object({
        current: z.number(),
        currentSince: z.number().nullable(),
        longest: z.number(),
        longestFrom: z.number().nullable(),
        longestTo: z.number().nullable(),
        lastUseAt: z.number().nullable(),
        lastOverdoseAt: z.number().nullable(),
      })
      .optional(),
  }),
  /**
   * Xanax funding, provenance-aware (stock-flow ledger):
   * - confirmedFaction: faction armory evidence tied to the member and time
   *   (use at the logged moment, or stock drawn from an armory withdrawal);
   * - confirmedPersonal: drawn from a recorded personal/travel purchase —
   *   ANY time, never clipped to the selected range;
   * - confirmedOther: explicit external evidence (e.g. a gift log);
   * - openingInventoryUnknown: drawn from stock that demonstrably existed
   *   before the range but whose origin is not proven by records;
   * - unknown: no ledger coverage at all (no pre-range evidence).
   *
   * The `personal`/`factionSponsored`/`unknownFunded` trio is the legacy
   * aggregate view (unknownFunded = everything not positively attributed).
   * A missing purchase inside the window NEVER implies unknown funding.
   */
  xanaxFunding: z.object({
    used: z.number(),
    /** In-range xanax overdoses — "used" counts ALL uses (an overdose also
     *  consumed a pill); successful = used - overdoses. */
    overdoses: z.number(),
    confirmedPersonal: z.number(),
    confirmedFaction: z.number(),
    confirmedOther: z.number(),
    openingInventoryUnknown: z.number(),
    unknown: z.number(),
    /** Ledger state at the range start. */
    openingStock: z.object({
      /** Recorded stock still held at the range start. */
      knownUnits: z.number(),
      fromRecordedPurchases: z.number(),
      fromFaction: z.number(),
      fromOther: z.number(),
      /** Proven-but-unrecorded stock at the range start (origin unknown). */
      unrecorded: z.number(),
    }),
    /** Earliest acquisition/use evidence feeding the ledger (unix seconds). */
    earliestEvidenceAt: z.number().nullable(),
    /** True when evidence exists strictly before the selected range. */
    hasPreRangeEvidence: z.boolean(),
    /**
     * Estimated catalog values per bucket. `consumption` values ALL Xanax
     * used at market price — it is NOT personal spend. Sponsored units cost
     * the player $0; opening-inventory value is an estimate only.
     */
    values: z.object({
      unitPrice: z.number().nullable(),
      /** Catalog market-data freshness (unix seconds of the price upsert). */
      priceUpdatedAt: z.number().nullable(),
      consumption: z.number().nullable(),
      factionSponsored: z.number().nullable(),
      confirmedPersonal: z.number().nullable(),
      openingInventory: z.number().nullable(),
    }),
    personal: z.number(),
    /** Linked to a faction armory / faction transfer record. */
    factionSponsored: z.number(),
    /** Everything not positively attributed (legacy aggregate). */
    unknownFunded: z.number(),
    armoryHistory: z.object({
      /** True when at least one armory news event is stored. */
      available: z.boolean(),
      events: z.number(),
      earliestAt: z.number().nullable(),
    }),
  }),
  byDrug: z.array(
    z.object({
      drug: z.string(),
      uses: z.number(),
      overdoses: z.number(),
      estimatedCost: z.number().nullable(),
      shareOfTotal: z.number(),
      /** 2.1.0: per-drug good-streak accounting (absent on older payloads). */
      lastUseAt: z.number().nullable().optional(),
      lastOverdoseAt: z.number().nullable().optional(),
      currentStreak: z.number().optional(),
      longestStreak: z.number().optional(),
    })
  ),
  dailySeries: z.array(z.object({ t: z.number(), good: z.number(), bad: z.number() })),
  rehab: z.object({
    totalSpend: KpiValueSchema,
    /**
     * Rehab VISITS — one Torn "Rehab" log row is one visit (Torn pre-groups
     * them); never the session count and never a time-cluster heuristic.
     */
    visits: z.number(),
    /**
     * Rehab SESSIONS actually purchased (sum of Torn's explicit
     * `rehab_times`). Null when no visit carried a session count —
     * rendered "Sessions unavailable", never inferred from row counts
     * or money.
     */
    sessions: z.number().nullable(),
    /** Visits whose session count the source payload did not carry. */
    sessionsUnavailable: z.number(),
    /** Mean sessions per visit, over visits with a known count. */
    averageSessionsPerVisit: z.number().nullable(),
    averageCostPerSession: KpiValueSchema,
    averageCostPerVisit: KpiValueSchema,
    latestAt: z.number().nullable(),
    averageSpend: KpiValueSchema,
    /** Per-visit trend, oldest first (sessions/cost are per visit). */
    visitTrend: z.array(
      z.object({
        startedAt: z.number(),
        sessions: z.number().nullable(),
        cost: z.number().nullable(),
        costPerSession: z.number().nullable(),
      })
    ),
    recent: z.array(
      z.object({
        occurredAt: z.number(),
        rehabPercent: z.number().nullable(),
        cost: z.number().nullable(),
      })
    ),
    /** 2.1.0 rehab deep metrics (absent on older payloads). */
    addictionPointsRemoved: z.number().nullable().optional(),
    addictionPointsKnownVisits: z.number().optional(),
    costPerAddictionPoint: KpiValueSchema.optional(),
    estimatedNextCost: KpiValueSchema.optional(),
    earliestAt: z.number().nullable().optional(),
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
  /**
   * Permission-aware availability per section (Phase: partial modules).
   * Absent on older clients; populated from the central feature matrix.
   */
  availability: z
    .object({
      current: FeatureAvailabilitySchema,
      history: FeatureAvailabilitySchema,
      purchases: FeatureAvailabilitySchema,
      profit: FeatureAvailabilitySchema,
    })
    .optional(),
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
  /**
   * Economically important items surfaced BY NAME with their share of travel
   * spend — meaningful items (e.g. Xanax) never hide inside "other".
   */
  topItems: z.array(
    z.object({
      item: z.string(),
      category: z.string(),
      quantity: z.number(),
      spend: z.number(),
      estimatedProfit: z.number().nullable(),
      /** Fraction of total in-range travel spend (0..1). */
      spendShare: z.number(),
    })
  ),
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
  /**
   * 2.0.5 travel/OC conflict input: median FLIGHT duration per destination
   * (seconds) over the player's own completed trips — exact recorded data,
   * stable per-destination game mechanic. Destinations without history are
   * absent: callers treat that as "duration unknown" and never invent one.
   */
  travelDurations: z.record(z.string(), z.number()),
  /**
   * 2.1.0 historical travel overview (absent on older payloads): trip
   * volume, flight time and per-destination economics. Flight time counts
   * only recorded durations / complete depart-return pairs.
   */
  overview: z
    .object({
      trips: z.number(),
      flightTimeSeconds: z.number(),
      averageFlightSeconds: z.number().nullable(),
      destinationsVisited: z.number(),
      tripsPerDay: z.number().nullable(),
      byDestination: z.array(
        z.object({
          destination: z.string(),
          trips: z.number(),
          flightTimeSeconds: z.number(),
          averageFlightSeconds: z.number().nullable(),
          itemsBought: z.number(),
          spend: z.number(),
          estimatedRevenue: z.number().nullable(),
          estimatedProfit: z.number().nullable(),
          averageProfitPerTrip: z.number().nullable(),
          averageProfitPerHour: z.number().nullable(),
          lastVisitAt: z.number(),
        })
      ),
      daily: z.array(
        z.object({
          t: z.number(),
          trips: z.number(),
          flightTimeSeconds: z.number(),
          profit: z.number().nullable(),
        })
      ),
    })
    .optional(),
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

/** Operational sync health per resource — SEPARATE from data confidence.
 * Derived server-side by the shared sync-health module; the frontend only
 * maps codes to copy. */
export const SyncOperationalMetaSchema = z.object({
  state: z.enum(SYNC_OPERATIONAL_STATES),
  reason: z.enum(SYNC_OPERATION_REASONS),
  since: z.number().nullable(),
  overdueBySeconds: z.number().nullable(),
  retryAt: z.number().nullable(),
  recoverable: z.boolean(),
  severity: z.enum(["info", "warning", "error"]),
});
export type SyncOperationalMetaDto = z.infer<typeof SyncOperationalMetaSchema>;
export type SyncOperationReasonDto = SyncOperationalMetaDto["reason"];
export type SyncSeverityDto = SyncOperationalMetaDto["severity"];

export const SyncIncidentSchema = z.object({
  kind: z.enum(["sync_failures", "stale_recovered", "capability_denied"]),
  severity: z.enum(["info", "warning", "error"]),
  reason: z.enum(SYNC_OPERATION_REASONS),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  autoRecovered: z.boolean(),
  failureCount: z.number(),
});
export type SyncIncidentDto = z.infer<typeof SyncIncidentSchema>;

export const SyncRunMetricsSchema = z.object({
  successRate24h: z.number().nullable(),
  failures24h: z.number(),
  avgDurationMs24h: z.number().nullable(),
  recoveries24h: z.number(),
});
export type SyncRunMetricsDto = z.infer<typeof SyncRunMetricsSchema>;

/** Full sync + system health for the Sync Status page. */
export const SyncHealthResponseSchema = z.object({
  running: z.boolean(),
  setupPhase: z.enum(["no_key", "queued", "syncing", "partial", "caught_up", "failed"]),
  /** Requested history window (worker config) coverage is judged against. */
  requestedHistoryDays: z.number(),
  /** 2.0 user-facing per-domain data freshness (worst-of-resources derivation). */
  freshness: z.array(DataFreshnessEntrySchema),
  resources: z.array(
    z.object({
      resource: SyncResourceSchema,
      status: z.string(),
      phase: z.enum(["queued", "running", "backfilling", "caught_up", "partial", "failed", "permission_required"]),
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
      /** Dataset-level confidence — distinct from the operational phase above. */
      confidence: DataConfidenceMetaSchema,
      /**
       * Operational sync health (is the refresh loop working?) — separate
       * vocabulary from confidence; never merged into one enum.
       */
      operational: SyncOperationalMetaSchema,
      /** Machine reason code of the last failure (null after a success). */
      lastErrorKind: z.string().nullable(),
      /** Recent incident episodes (max 5, derived from SyncRun history). */
      recentIncidents: z.array(SyncIncidentSchema),
      /** Lightweight 24h run metrics (null when the resource never ran). */
      metrics: SyncRunMetricsSchema.nullable(),
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
  capabilities: KeyCapabilitiesSchema.nullable(),
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

/* -------------------------------------------------------------------------- */
/* Push notifications                                                          */
/* -------------------------------------------------------------------------- */

export const NotificationsStatusResponseSchema = z.object({
  /** False when the server has no VAPID keys configured. */
  pushConfigured: z.boolean(),
  devices: z.array(
    z.object({
      id: z.string(),
      userAgent: z.string().nullable(),
      /** Coarse human label derived from the user agent ("iPhone · iOS 17.5",
       *  "Mac · Chrome") — never a raw UA string in the UI. Optional for
       *  deploy-order tolerance; clients fall back to a truncated UA. */
      label: z.string().optional(),
      createdAt: z.number(),
      lastSeenAt: z.number(),
      /** True when this row is the browser making the request. */
      current: z.boolean(),
    })
  ),
  preferences: z.object({
    /** Type toggles keyed by canonical NOTIFICATION_TYPES id (legacy keys
     *  normalized server-side). */
    categories: z.record(z.string(), z.boolean()),
    sensitiveDetails: z.boolean(),
    quietStartMin: z.number().nullable(),
    quietEndMin: z.number().nullable(),
    /** Critical alerts may bypass quiet hours. */
    bypassCritical: z.boolean(),
    /** Per-type inline configuration (resolved with shared defaults). */
    typeConfig: z.record(z.string(), z.number()),
    enabledAt: z.number().nullable(),
  }),
});
export type NotificationsStatusResponse = z.infer<typeof NotificationsStatusResponseSchema>;

/** One logical notification event with its per-device delivery outcomes —
 *  the user-visible delivery history (Settings → Notifications). */
export const NotificationHistoryResponseSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      body: z.string(),
      occurredAt: z.number(),
      /** pending | deferred | delivered | failed | suppressed | expired */
      status: z.string(),
      /** Machine reason for a non-delivered outcome (friendly-labeled in UI). */
      reason: z.string().nullable(),
      provenance: z.string(),
      deliveries: z.array(
        z.object({
          status: z.string(),
          reason: z.string().nullable(),
          attempts: z.number(),
          sentAt: z.number().nullable(),
          /** Coarse device label — NEVER the raw endpoint URL. */
          device: z.string().nullable(),
        })
      ),
    })
  ),
});
export type NotificationHistoryResponse = z.infer<typeof NotificationHistoryResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Progression & Energy Intelligence (roadmap item)                            */
/* -------------------------------------------------------------------------- */

export const ProgressionStatKeySchema = z.enum(["strength", "defense", "speed", "dexterity"]);
export type ProgressionStatKey = z.infer<typeof ProgressionStatKeySchema>;

/** How strongly stored evidence supports an inferred classification. */
export const InferenceStrengthSchema = z.enum(["likely", "possible"]);
export type InferenceStrength = z.infer<typeof InferenceStrengthSchema>;

export const TrainingSessionSchema = z.object({
  startedAt: z.number(),
  endedAt: z.number(),
  /** Bounded energy inference for the burst; null when bars are uncovered.
   *  Cap-aware (Xanax energy above the cap is excluded) and net of nothing —
   *  regeneration during the burst is not separable, so UI must show "~". */
  energySpent: z.number().nullable(),
  energyKnown: z.boolean(),
  /** Observed battlestat gain bracketing the session; null when shared. */
  gains: z.record(ProgressionStatKeySchema, z.number()).nullable(),
  /** Bracket delta net of exact job/company stat gains — the gym share. */
  gymGain: z.number().nullable(),
  totalGain: z.number().nullable(),
  /** Exact job/company stat points inside the bracket (non-gym). */
  nonGymJobGain: z.number(),
  /** Stat trains received inside the bracket (count only). */
  friendTrains: z.number(),
  gainPerEnergy: z.number().nullable(),
  primaryStat: z.string().nullable(),
  inference: InferenceStrengthSchema,
  evidence: z.array(z.string()),
  bracketShared: z.boolean(),
});
export type TrainingSessionDto = z.infer<typeof TrainingSessionSchema>;

export const HappyJumpSchema = z.object({
  preparedFrom: z.number(),
  trainedFrom: z.number(),
  trainedTo: z.number(),
  xanaxCount: z.number(),
  ecstasyCount: z.number(),
  /** null = no refill evidence either way (never a fabricated false). */
  refillUsed: z.boolean().nullable(),
  energySpent: z.number().nullable(),
  totalGain: z.number().nullable(),
  primaryStat: z.string().nullable(),
  gainPerEnergy: z.number().nullable(),
  peakHappyObserved: z.number().nullable(),
  confidence: InferenceStrengthSchema,
  signals: z.array(z.string()),
  evidence: z.array(z.string()),
  missing: z.array(z.string()),
});
export type HappyJumpDto = z.infer<typeof HappyJumpSchema>;

export const StatMilestoneSchema = z.object({
  kind: z.string(),
  label: z.string(),
  threshold: z.number(),
  crossedBetween: z.tuple([z.number(), z.number()]),
});
export type StatMilestoneDto = z.infer<typeof StatMilestoneSchema>;

/**
 * Progression & Energy Intelligence. Every figure carries its semantic class
 * via provenance/inference fields: exact (Torn verbatim), derived
 * (deterministic from exact), estimated (documented convention — Xanax
 * energy), inferred (pattern classification: sessions/jumps). Energy history
 * exists only from BarsSnapshot collection start; battlestat history comes
 * from hourly personalstat snapshots (battle_stats).
 */
/* -------------------------------------------------------------------------- */
/* Training Intelligence 2.0 (progression extension)                           */
/* -------------------------------------------------------------------------- */

const TrainingPeriodStatsSchema = z.object({
  from: z.number(),
  to: z.number(),
  label: z.string(),
  sessions: z.number(),
  energyTrained: z.number().nullable(),
  statGain: z.number().nullable(),
  gainPerEnergyMedian: z.number().nullable(),
  cappedHours: z.number(),
});

const TrainingRecordSchema = z.object({ value: z.number(), at: z.number(), sampleSize: z.number() });

export const ProgressionResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  generatedAt: z.number(),
  availability: z
    .object({
      battlestats: FeatureAvailabilitySchema,
      energy: FeatureAvailabilitySchema,
      training: FeatureAvailabilitySchema,
      happyJumps: FeatureAvailabilitySchema,
    })
    .optional(),
  summary: z.object({
    totalBattlestats: KpiValueSchema,
    totalDelta: KpiValueSchema,
    gainPerDay: KpiValueSchema,
    /** Energy attributed to training by session inference (never exact). */
    energyTrained: KpiValueSchema,
    sessions: z.number(),
    likelyJumps: z.number(),
  }),
  battlestats: z.object({
    perStat: z.array(
      z.object({
        key: ProgressionStatKeySchema,
        label: z.string(),
        opening: z.number().nullable(),
        closing: z.number().nullable(),
        delta: z.number().nullable(),
        changePct: z.number().nullable(),
      })
    ),
    openingTotal: z.number().nullable(),
    closingTotal: z.number().nullable(),
    deltaTotal: z.number().nullable(),
    changePct: z.number().nullable(),
    gainPerDay: z.number().nullable(),
    /** "at_range_start" = true range change; "tracked_since" = baseline is
     *  the first in-range snapshot (tracking began inside the range — the
     *  change covers a shorter span than requested); null = no baseline. */
    baselineKind: z.enum(["at_range_start", "tracked_since"]).nullable().optional(),
    /** Observed baseline→closing span in days; gainPerDay needs >= 1. */
    spanDays: z.number().nullable().optional(),
    /** Exact attribution split of deltaTotal (gym vs job vs other). */
    attribution: z
      .object({
        gym: z.number().nullable(),
        job: z.number().nullable(),
        other: z.number().nullable(),
        friendTrains: z.number().nullable(),
      })
      .optional(),
    distribution: z.array(z.object({ key: ProgressionStatKeySchema, share: z.number().nullable() })),
    series: z.array(
      z.object({
        t: z.number(),
        strength: z.number().nullable(),
        defense: z.number().nullable(),
        speed: z.number().nullable(),
        dexterity: z.number().nullable(),
        total: z.number().nullable(),
      })
    ),
    milestones: z.array(StatMilestoneSchema),
    /** First observation in stored history — nothing before it exists. */
    trackedSince: z.number().nullable(),
    confidence: DataConfidenceMetaSchema,
  }),
  energy: z.object({
    /** False when no bar snapshots exist in range — everything stays null. */
    covered: z.boolean(),
    coveredFrom: z.number().nullable(),
    coveredTo: z.number().nullable(),
    sources: z.array(z.object({ category: z.string(), amount: z.number(), provenance: ProvenanceSchema })),
    uses: z.array(z.object({ category: z.string(), amount: z.number(), provenance: ProvenanceSchema })),
    derivedRegen: z.number().nullable(),
    regenPerHour: z.number().nullable(),
    /** Estimated regen while observed pinned at cap — never claimed as gained. */
    potentialRegen: z.number().nullable(),
    /** Lower-bound seconds observed at cap (snapshot-bounded). */
    cappedSeconds: z.number().nullable(),
    /** Delivered gains that cannot be placed between two snapshots (a Xanax
     *  trained away before the next poll, pinned intervals): consumed,
     *  banked above max, or wasted — not observable, never claimed lost. */
    unresolvedGains: z.number().nullable(),
    /** Same unresolved split by source category. */
    unresolvedGainsByCategory: z.array(z.object({ category: z.string(), amount: z.number() })),
    /** Xanax uses recorded in range (success outcomes) with the estimated
     *  energy delivered per use and the portion inside likely training
     *  sessions — present even when nothing was directly observed, so a day
     *  with 2 uses never reads as "0 Xanax". */
    xanax: z
      .object({
        uses: z.number(),
        estimatedDelivered: z.number(),
        attributedToTraining: z.number(),
      })
      .nullable(),
    reconciliation: z.object({
      opening: z.number().nullable(),
      closing: z.number().nullable(),
      observedDelta: z.number().nullable(),
      quality: z.enum(["full", "partial", "unavailable"]),
    }),
    confidence: DataConfidenceMetaSchema,
  }),
  training: z.object({
    sessions: z.array(TrainingSessionSchema),
    medianGainPerEnergy: z.number().nullable(),
    baselineMedianGainPerEnergy: z.number().nullable(),
    baselineSamples: z.number(),
    /** Current-period gain/E ratio vs the personal baseline (1.0 = equal). */
    efficiencyVsBaseline: z.number().nullable(),
    daysTrained: z.number(),
    avgEnergyPerTrainingDay: z.number().nullable(),
    normalVsJump: z.object({
      normalMedianGainPerEnergy: z.number().nullable(),
      jumpMedianGainPerEnergy: z.number().nullable(),
      normalSamples: z.number(),
      jumpSamples: z.number(),
    }),
    confidence: DataConfidenceMetaSchema,
  }),
  happyJumps: z.object({
    jumps: z.array(HappyJumpSchema),
    confidence: DataConfidenceMetaSchema,
  }),
  /** 2.0 Training Intelligence — trailing 7d/7d/30d windows, records and the (correlational) time-of-day observation. */
  trainingIntelligence: z.object({
    current: TrainingPeriodStatsSchema,
    previous: TrainingPeriodStatsSchema,
    baseline30d: TrainingPeriodStatsSchema,
    records: z.object({
      bestGainPerEnergyDay: TrainingRecordSchema.nullable(),
      bestStatGainDay: TrainingRecordSchema.nullable(),
      bestWeek: TrainingRecordSchema.nullable(),
    }),
    timeOfDay: z
      .object({
        buckets: z.array(
          z.object({
            hourStart: z.number(),
            label: z.string(),
            sessions: z.number(),
            gainPerEnergyMedian: z.number().nullable(),
          })
        ),
        best: z.object({ label: z.string(), sessions: z.number(), gainPerEnergyMedian: z.number(), upliftPct: z.number() }).nullable(),
        overallMedian: z.number().nullable(),
        sampleSize: z.number(),
        note: z.string(),
      })
      .nullable(),
    provenance: z.literal("inferred"),
  }),
  profile: z.object({
    level: z.number().nullable(),
    levelHistory: z.array(z.object({ t: z.number(), level: z.number() })),
    awards: z.number().nullable(),
    awardsDelta: z.number().nullable(),
  }),
});
export type ProgressionResponse = z.infer<typeof ProgressionResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Merits & Stocks (v0.2 feature completion)                                   */
/* -------------------------------------------------------------------------- */

export const MeritRowDtoSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  /** Exact rank; null = untouched (never in upgrades). */
  level: z.number().nullable(),
  /** TornScope-maintained cap; null = not maintained (never claims maxed). */
  maxLevel: z.number().nullable(),
  remaining: z.number().nullable(),
  owned: z.boolean(),
  state: z.enum(["maxed", "partial", "owned", "untouched"]),
  /** Exact level exceeds the maintained cap — catalog needs an update. */
  catalogMismatch: z.boolean(),
});

export const MeritSummaryDtoSchema = z.object({
  used: z.number(),
  available: z.number().nullable(),
  medals: z.number().nullable(),
  honors: z.number().nullable(),
  ownedCount: z.number(),
  maxedCount: z.number(),
  partialCount: z.number(),
  untouchedCount: z.number(),
  /** Invested merits whose cap TornScope does not maintain. */
  capUnknownCount: z.number(),
  byCategory: z.array(z.object({ category: z.string(), points: z.number() })),
});

export const MeritsResponseSchema = z.object({
  summary: MeritSummaryDtoSchema,
  merits: z.array(MeritRowDtoSchema),
  availability: FeatureAvailabilitySchema,
  /** When the official catalog could not be fetched, names come back null. */
  catalogDegraded: z.boolean(),
});

export type MeritRowDto = z.infer<typeof MeritRowDtoSchema>;
export type MeritSummaryDto = z.infer<typeof MeritSummaryDtoSchema>;
export type MeritsResponse = z.infer<typeof MeritsResponseSchema>;

export const StockRewardDtoSchema = z.object({
  kind: z.enum(["fixed_cash", "item", "points", "bar_refill", "non_monetary", "unvalued"]),
  description: z.string(),
  cash: z.number().nullable(),
  quantity: z.number().nullable(),
  itemName: z.string().nullable(),
  points: z.number().nullable(),
  /** Estimated (or exact-cash) value of ONE payout; null = not valuated. */
  valuePerPayout: z.number().nullable(),
  valueIsExact: z.boolean(),
});

export const PayoutTimingDtoSchema = z.object({
  kind: z.enum(["ready", "derived", "unavailable"]),
  daysRemaining: z.number().nullable(),
  basis: z.string(),
});

export const StockRowDtoSchema = z.object({
  id: z.number(),
  name: z.string(),
  acronym: z.string(),
  owned: z.boolean(),
  shares: z.number().nullable(),
  positionValue: z.number().nullable(),
  benefitDescription: z.string().nullable(),
  benefitRequirement: z.number().nullable(),
  benefitFrequencyDays: z.number().nullable(),
  benefitPassive: z.boolean().nullable(),
  reward: StockRewardDtoSchema.nullable(),
  benefitReached: z.boolean(),
  timing: PayoutTimingDtoSchema.nullable(),
  missingShares: z.number().nullable(),
  estimatedCostToBenefit: z.number().nullable(),
  estimatedAnnualValue: z.number().nullable(),
  estimatedYieldPct: z.number().nullable(),
  estimatedPaybackDays: z.number().nullable(),
  yieldCapitalBasis: z.number().nullable(),
  priceCapturedAt: z.number().nullable(),
});

export const StockSummaryDtoSchema = z.object({
  /** Owned positions only; null without prices. Estimated at current price. */
  portfolioValue: z.number().nullable(),
  stocksOwned: z.number(),
  activeBenefits: z.number(),
  /** Sum of valued rewards' annualized value; unvalued rewards excluded and
   *  disclosed via unvaluedBenefitCount. */
  estimatedAnnualBenefit: z.number().nullable(),
  unvaluedBenefitCount: z.number(),
});

export const StocksResponseSchema = z.object({
  summary: StockSummaryDtoSchema,
  rows: z.array(StockRowDtoSchema),
  availability: FeatureAvailabilitySchema,
  priceCapturedAt: z.number().nullable(),
  /** Items whose catalog lookup failed (they render as unvalued rewards). */
  unvaluedItemNames: z.array(z.string()),
});

export type StockRowDto = z.infer<typeof StockRowDtoSchema>;
export type StocksResponse = z.infer<typeof StocksResponseSchema>;
export type StockSummaryDto = z.infer<typeof StockSummaryDtoSchema>;

/* -------------------------------------------------------------------------- */
/* System Health (2.0)                                                         */
/* -------------------------------------------------------------------------- */

export const SystemHealthResponseSchema = z.object({
  generatedAt: z.number(),
  services: z.object({
    api: z.object({ status: z.literal("ok"), version: z.string(), gitSha: z.string(), environment: z.string() }),
    database: z.object({ status: z.string() }),
    redis: z.object({ status: z.string() }),
    worker: z.object({ status: z.string(), heartbeatAgeSeconds: z.number().nullable() }),
    tornApi: z.object({ status: z.enum(["ok", "degraded", "unknown"]), lastSuccessAt: z.number().nullable(), note: z.string() }),
  }),
  sync: z.object({
    running: z.boolean(),
    failingResources: z.array(z.object({ resource: z.string(), state: z.string(), lastErrorKind: z.string().nullable() })),
    lastSuccessAt: z.number().nullable(),
    queue: z.object({
      waiting: z.number(),
      active: z.number(),
      delayed: z.number(),
      failed: z.number(),
      oldestOutstandingAt: z.number().nullable(),
    }),
  }),
  freshness: z.array(DataFreshnessEntrySchema),
});
export type SystemHealthResponse = z.infer<typeof SystemHealthResponseSchema>;

/* -------------------------------------------------------------------------- */
/* 2.1.0 — Deep Analytics                                                      */
/* -------------------------------------------------------------------------- */

/** Value provenance incl. bounded inference (same ladder as insights). */
export const EnergyProvenanceSchema = z.enum(["exact", "derived", "estimated", "inferred"]);
export type EnergyProvenance = z.infer<typeof EnergyProvenanceSchema>;

const EnergyBreakdownRowSchema = z.object({
  category: z.string(),
  label: z.string(),
  amount: z.number(),
  events: z.number(),
  provenance: EnergyProvenanceSchema,
  share: z.number().nullable(),
  /** Exact points cost (refill rows only). */
  pointsUsed: z.number().nullable().optional(),
});

export const EnergySummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  generatedAt: z.number(),
  availability: z
    .object({
      bars: FeatureAvailabilitySchema,
      logs: FeatureAvailabilitySchema,
    })
    .optional(),
  balance: z.object({
    generated: z.object({ value: z.number().nullable(), provenance: EnergyProvenanceSchema }),
    gainedExternally: z.object({ value: z.number(), provenance: EnergyProvenanceSchema }),
    spent: z.object({ value: z.number().nullable(), provenance: EnergyProvenanceSchema }),
    lost: z.object({ value: z.number(), provenance: EnergyProvenanceSchema }),
    net: z.object({ value: z.number().nullable(), provenance: EnergyProvenanceSchema }),
  }),
  sources: z.array(EnergyBreakdownRowSchema),
  uses: z.array(EnergyBreakdownRowSchema),
  losses: z.array(EnergyBreakdownRowSchema),
  daily: z.array(z.object({ t: z.number(), gained: z.number(), spent: z.number(), lost: z.number() })),
  chartInterval: z.enum(["day", "week", "month"]),
  coverage: z.object({
    accountedShare: z.number().nullable(),
    coveredFrom: z.number().nullable(),
    coveredTo: z.number().nullable(),
    truncated: z.boolean(),
    quality: z.enum(["full", "partial", "unavailable"]),
  }),
  intelligence: z.object({
    averageEnergyPerDay: z.object({ value: z.number().nullable(), provenance: EnergyProvenanceSchema }),
    gymShareOfSpent: z.number().nullable(),
    attackShareOfSpent: z.number().nullable(),
    xanaxPerDay: z.object({ value: z.number().nullable(), provenance: EnergyProvenanceSchema }),
    refillCount: z.number(),
    refillEnergy: z.number(),
    refillPointsSpent: z.number().nullable(),
    potentialRegenWhileCapped: z.object({ value: z.number().nullable(), provenance: EnergyProvenanceSchema }),
    cappedHoursObserved: z.number(),
  }),
});
export type EnergySummaryResponse = z.infer<typeof EnergySummaryResponseSchema>;

export const LogEventDtoSchema = z.object({
  id: z.string(),
  occurredAt: z.number(),
  category: z.string().nullable(),
  title: z.string(),
  /** Human summary (description or formatted payload digest). */
  summary: z.string().nullable(),
  /** Generic numeric value when the payload carries one. */
  value: z.number().nullable(),
  /** Money delta when the payload carries one (exact from the log). */
  money: z.number().nullable(),
  /** Energy delta (±) when the payload carries one (exact from the log). */
  energy: z.number().nullable(),
  /** Small structured digest of the raw payload for the details view. */
  details: z.array(z.object({ key: z.string(), value: z.string() })),
  provenance: EnergyProvenanceSchema,
});
export type LogEventDto = z.infer<typeof LogEventDtoSchema>;

export const LogsResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  items: z.array(LogEventDtoSchema),
  nextCursor: z.string().nullable(),
  /** Total rows matching the filters within the range (bounded count). */
  total: z.number().nullable().optional(),
});
export type LogsResponse = z.infer<typeof LogsResponseSchema>;

/** Filter options derived from the user's OWN stored archive. */
export const LogsMetaResponseSchema = z.object({
  categories: z.array(z.object({ category: z.string(), count: z.number() })),
  titles: z.array(z.object({ title: z.string(), count: z.number() })),
  totalLogs: z.number(),
  oldestAt: z.number().nullable(),
});
export type LogsMetaResponse = z.infer<typeof LogsMetaResponseSchema>;

export const LogExportFormatSchema = z.enum(["csv", "json"]);
export type LogExportFormat = z.infer<typeof LogExportFormatSchema>;

/* -------------------------------------------------------------------------- */
/* 2.3.0 — Decision Intelligence                                               */
/* -------------------------------------------------------------------------- */

export const DecisionCategorySchema = z.enum(["OPPORTUNITY", "RISK", "INEFFICIENCY", "TREND", "MILESTONE", "ANOMALY"]);
export const DecisionConfidenceSchema = z.enum(["high", "medium", "low"]);
export const DecisionDomainSchema = z.enum(["energy", "drugs", "travel", "money", "goals"]);
export type DecisionDomain = z.infer<typeof DecisionDomainSchema>;

export const DecisionSignalSchema = z.object({
  id: z.string(),
  domain: DecisionDomainSchema,
  category: DecisionCategorySchema,
  title: z.string(),
  summary: z.string(),
  evidence: z.array(z.string()),
  impact: z.string(),
  confidence: DecisionConfidenceSchema,
  provenance: ProvenanceSchema,
  urgency: z.number(),
  horizon: z.enum(["now", "7d", "30d", "90d"]),
  metricBefore: z.number().nullable(),
  metricAfter: z.number().nullable(),
  metricUnit: z.string(),
  reason: z.string(),
  limitations: z.array(z.string()),
  actionUrl: z.string(),
  generatedAt: z.number(),
  /** Lifecycle (reconciled against the profile's persisted signal state). */
  isNew: z.boolean(),
  firstSeenAt: z.number().nullable(),
});
export type DecisionSignalDto = z.infer<typeof DecisionSignalSchema>;

export const DecisionSignalsResponseSchema = z.object({
  generatedAt: z.number(),
  signals: z.array(DecisionSignalSchema),
  overviewSignals: z.array(z.string()),
  recentlyResolved: z.array(z.object({ id: z.string(), domain: DecisionDomainSchema, resolvedAt: z.number() })),
  suppressedInsufficientData: z.number(),
  domainsSuppressed: z.array(DecisionDomainSchema),
  coverage: z.record(
    DecisionDomainSchema,
    z.object({ coveredDays: z.number(), events: z.number(), trackingSince: z.number().nullable() })
  ),
  prefs: z.object({
    enabled: z.boolean(),
    domains: z.record(DecisionDomainSchema, z.boolean()),
    includeLowConfidence: z.boolean(),
    maxOverviewSignals: z.number(),
  }),
});
export type DecisionSignalsResponse = z.infer<typeof DecisionSignalsResponseSchema>;

export const DecisionPrefsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    domains: z.object({ energy: z.boolean().optional(), drugs: z.boolean().optional(), travel: z.boolean().optional(), money: z.boolean().optional(), goals: z.boolean().optional() }).optional(),
    includeLowConfidence: z.boolean().optional(),
    maxOverviewSignals: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type DecisionPrefsUpdate = z.infer<typeof DecisionPrefsUpdateSchema>;

export const CasinoGameSummarySchema = z.object({
  game: z.string(),
  label: z.string(),
  plays: z.number(),
  wagered: z.number().nullable(),
  cashWon: z.number().nullable(),
  net: z.number().nullable(),
  lastPlayedAt: z.number().nullable(),
});

export const CasinoSummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  activities: z.number(),
  totalWagered: z.object({ value: z.number().nullable(), provenance: z.string() }),
  cashReturned: z.object({ value: z.number().nullable(), provenance: z.string() }),
  netCash: z.object({ value: z.number().nullable(), provenance: z.string() }),
  outcomeCounts: z.record(z.string(), z.number()),
  games: z.array(CasinoGameSummarySchema),
  activeDays: z.number(),
  bestResult: z.object({ label: z.string(), net: z.number(), occurredAt: z.number() }).nullable(),
  worstResult: z.object({ label: z.string(), net: z.number(), occurredAt: z.number() }).nullable(),
  /** Bookie withdrawals: balance movements excluded from game economics. */
  withdrawn: z.number().nullable(),
  /** Stakes placed without settlement semantics yet — activity, never a loss. */
  pendingActivities: z.number(),
  coverage: z.object({ activities: z.number(), trackingSince: z.number().nullable() }),
  availability: z.object({ history: FeatureAvailabilitySchema }).optional(),
});
export type CasinoSummaryResponse = z.infer<typeof CasinoSummaryResponseSchema>;

export const RewardsItemRewardSchema = z.object({
  itemId: z.number(),
  label: z.string().nullable(),
  qty: z.number(),
  unitPriceEstimate: z.number().nullable(),
  valueEstimate: z.number().nullable(),
});

export const RewardsSummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  openings: z.number(),
  containerTypes: z.number(),
  cashReceived: z.number().nullable(),
  /** Opened-item value at CURRENT catalog prices — an estimate, never exact. */
  inputValueEstimate: z.object({ value: z.number().nullable(), provenance: z.string() }),
  /** Reward item value at CURRENT catalog prices — an estimate, never exact. */
  itemValueEstimate: z.object({ value: z.number().nullable(), provenance: z.string() }),
  /** cash (exact) + item rewards (est) − input value (est); null when nothing is defensibly valued. */
  estimatedNet: z.object({ value: z.number().nullable(), provenance: z.string() }),
  /** complete = everything valued; partial = valued + unpriced mixed;
   *  unpriced = rewards exist but nothing is defensibly valued. */
  valuationCoverage: z.enum(["complete", "partial", "unpriced"]),
  /** Reward components that no longer parse (payload drift) — excluded from
   *  all sums, never priced, never zeroed. */
  malformedComponents: z.number(),
  topItemRewards: z.array(RewardsItemRewardSchema),
  /** Reward/input quantities with no catalog price — kept visible, never $0. */
  unpricedItemQty: z.number(),
  types: z.array(z.object({
    activityType: z.string(),
    label: z.string(),
    openings: z.number(),
    cashReward: z.number().nullable(),
    lastOpenedAt: z.number().nullable(),
  })),
  coverage: z.object({ openings: z.number(), trackingSince: z.number().nullable() }),
  availability: z.object({ history: FeatureAvailabilitySchema }).optional(),
});
export type RewardsSummaryResponse = z.infer<typeof RewardsSummaryResponseSchema>;

export const HuntingSessionTypeSchema = z.object({
  type: z.string(),
  hunts: z.number(),
  cashEarned: z.number().nullable(),
  cashSpent: z.number().nullable(),
  net: z.number().nullable(),
});

export const HuntingSkillSchema = z.object({
  current: z.number().nullable(),
  firstSeen: z.number().nullable(),
  totalGain: z.number().nullable(),
  levelUps: z.number(),
});

export const HuntingRecentHuntSchema = z.object({
  occurredAt: z.number(),
  subtype: z.string().nullable(),
  cashSpent: z.number().nullable(),
  cashEarned: z.number().nullable(),
  net: z.number().nullable(),
  skillLevel: z.number().nullable(),
  skillGain: z.number().nullable(),
});

export const HuntingSummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  hunts: z.number(),
  levelUps: z.number(),
  cashEarned: z.number().nullable(),
  cashSpent: z.number().nullable(),
  netCash: z.object({ value: z.number().nullable(), provenance: z.string() }),
  valuePerHunt: z.number().nullable(),
  activeDays: z.number(),
  bestHunt: z.object({ net: z.number(), occurredAt: z.number() }).nullable(),
  sessionTypes: z.array(HuntingSessionTypeSchema),
  skill: HuntingSkillSchema,
  recent: z.array(HuntingRecentHuntSchema),
  coverage: z.object({ hunts: z.number(), trackingSince: z.number().nullable() }),
  availability: z.object({ history: FeatureAvailabilitySchema }).optional(),
});
export type HuntingSummaryResponse = z.infer<typeof HuntingSummaryResponseSchema>;

export const ActivityBreakdownRowSchema = z.object({
  activityType: z.string(),
  subtype: z.string().nullable(),
  count: z.number(),
  cashSpent: z.number().nullable(),
  cashReceived: z.number().nullable(),
  net: z.number().nullable(),
  points: z.number().nullable(),
  tokens: z.number().nullable(),
});

export const ActivityDomainSummarySchema = z.object({
  domain: z.string(),
  label: z.string(),
  activities: z.number(),
  cashSpent: z.number().nullable(),
  cashReceived: z.number().nullable(),
  exactNetCash: z.number().nullable(),
  estimatedItemValue: z.number().nullable(),
  /** Activities whose only reward has no defensible valuation — kept visible, never zeroed. */
  unpricedActivities: z.number().nullable(),
  progressionPoints: z.number().nullable(),
  progressionTokens: z.number().nullable(),
  /** true when this domain's cash also flows through the MoneyEvent ledger. */
  ledgerLinked: z.boolean(),
  lastActivityAt: z.number().nullable(),
  breakdown: z.array(ActivityBreakdownRowSchema),
});

export const ActivityReconciliationRowSchema = z.object({
  domain: z.string(),
  activityCash: z.number().nullable(),
  ledgerCash: z.number().nullable(),
  difference: z.number().nullable(),
  semanticOnly: z.boolean(),
  note: z.string().nullable(),
});

export const ActivitySummaryResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number() }),
  activities: z.number(),
  exactNetCash: z.number().nullable(),
  estimatedItemValue: z.object({ value: z.number().nullable(), provenance: z.string() }),
  unpricedActivities: z.number(),
  domains: z.array(ActivityDomainSummarySchema),
  reconciliation: z.array(ActivityReconciliationRowSchema),
  coverage: z.object({ activities: z.number(), trackingSince: z.number().nullable() }),
  availability: z.object({ history: FeatureAvailabilitySchema }).optional(),
});
export type ActivitySummaryResponse = z.infer<typeof ActivitySummaryResponseSchema>;
