import { z } from "zod";
import { MONEY_CATEGORIES, MONEY_DIRECTIONS, SYNC_RESOURCES } from "./torn.js";
import type { Provenance } from "./provenance.js";

/* -------------------------------------------------------------------------- */
/* Date range                                                                 */
/* -------------------------------------------------------------------------- */

export const DATE_RANGE_PRESETS = [
  "today",
  "7d",
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
      return { from: startOfToday, to: endOfToday };
    case "7d":
      return { from: startOfToday - 6 * 86_400, to: endOfToday };
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
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const KpiValueSchema = z.object({
  value: z.number().nullable(),
  provenance: ProvenanceSchema,
  label: z.string().optional(),
});
export type KpiValue = z.infer<typeof KpiValueSchema>;

export const DashboardResponseSchema = z.object({
  range: z.object({ from: z.number(), to: z.number(), interval: z.string() }),
  netWorth: KpiValueSchema,
  cash: KpiValueSchema,
  income30d: KpiValueSchema,
  expenses30d: KpiValueSchema,
  netGain30d: KpiValueSchema,
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
