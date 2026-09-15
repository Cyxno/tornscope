/**
 * Shared demo-data constants (full seed and incremental top-up). One source
 * of truth so the two paths can never drift into different synthetic models.
 */

export const DEMO_TORN_ID = 2_000_000_001;
export const DEMO_FACTION_ID = 9999;

export const DAY = 86_400;
export const HOUR = 3600;

export const DRUGS = [
  { name: "Xanax", itemId: 206, price: 45_000, weight: 5 },
  { name: "Ecstasy", itemId: 200, price: 12_000, weight: 4 },
  { name: "Cannabis", itemId: 196, price: 9_000, weight: 6 },
  { name: "Speed", itemId: 201, price: 25_000, weight: 3 },
  { name: "Vicodin", itemId: 203, price: 9_500, weight: 4 },
  { name: "Opium", itemId: 199, price: 70_000, weight: 1 },
  { name: "LSD", itemId: 197, price: 30_000, weight: 2 },
  { name: "Ketamine", itemId: 198, price: 15_000, weight: 2 },
  { name: "PCP", itemId: 204, price: 38_000, weight: 1 },
  { name: "Shrooms", itemId: 205, price: 22_000, weight: 2 },
  { name: "Love Juice", itemId: 417, price: 35_000, weight: 1 },
] as const;

export const DESTINATIONS = [
  { name: "Argentina", flightHours: 11 },
  { name: "Canada", flightHours: 7 },
  { name: "Cayman Islands", flightHours: 6 },
  { name: "China", flightHours: 15 },
  { name: "Hawaii", flightHours: 10 },
  { name: "Japan", flightHours: 14 },
  { name: "Mexico", flightHours: 4 },
  { name: "South Africa", flightHours: 15 },
  { name: "Switzerland", flightHours: 9 },
  { name: "UAE", flightHours: 12 },
  { name: "United Kingdom", flightHours: 8 },
] as const;

export const PLUSHIES = [
  { name: "Teddy Bear Plushie", itemId: 445, market: 26_000 },
  { name: "Kitten Plushie", itemId: 449, market: 24_000 },
  { name: "Jaguar Plushie", itemId: 457, market: 90_000 },
  { name: "Nessie Plushie", itemId: 473, market: 55_000 },
  { name: "Red Fox Plushie", itemId: 468, market: 38_000 },
] as const;

export const FLOWERS = [
  { name: "Ceibo Blossom", itemId: 265, market: 18_000 },
  { name: "Edelweiss", itemId: 262, market: 60_000 },
  { name: "Cherry Blossom", itemId: 260, market: 27_000 },
  { name: "Peony", itemId: 263, market: 22_000 },
  { name: "African Violet", itemId: 276, market: 20_000 },
] as const;

export const MONEY_SEEDS = [
  { category: "crime", label: "Crime payout", min: 5_000, max: 120_000, weight: 6 },
  { category: "mugging", label: "Mugged a player", min: 2_000, max: 90_000, weight: 3 },
  { category: "ranked_war", label: "Ranked war payout", min: 40_000, max: 400_000, weight: 1 },
  { category: "casino", label: "Casino win", min: 1_000, max: 250_000, weight: 2 },
  { category: "stock", label: "Stock dividend", min: 10_000, max: 60_000, weight: 1 },
  { category: "trading", label: "Item sale", min: 5_000, max: 300_000, weight: 3 },
] as const;

export const EXPENSE_SEEDS = [
  { category: "points", label: "Bought 100 points", min: 45_000, max: 52_000 },
  { category: "items", label: "Bought weapons & armor", min: 10_000, max: 400_000 },
  { category: "bazaar", label: "Bazaar restock", min: 5_000, max: 150_000 },
  { category: "housing", label: "Property rent paid", min: 20_000, max: 80_000 },
] as const;

export const COMBAT_OPPONENTS: Array<[number, string | null, string]> = [
  [777001, "DEMO_Rival", "Attacked"],
  [777002, "DEMO_Target", "Mugged"],
  [777003, "DEMO_Bully", "Lost"],
  [777004, "DEMO_Ghost", "Hospitalized"],
  [777005, null, "Attacked"],
];

/** Day archetypes for the wealth-first acceptance cases (Phase: demo should
 *  visibly exercise the financial semantics rework):
 *  - "conversion": big item buy+sell — cash dips, wealth roughly flat/up.
 *  - "cost":       rehab + heavy true costs — wealth declines.
 *  - "income":     salary/interest — wealth grows.
 *  - "normal":     mixed everyday flow. */
export type DemoDayKind = "normal" | "income" | "conversion" | "cost";

export function dayKindFor(dayNumber: number): DemoDayKind {
  const roll = dayNumber % 10;
  if (roll < 4) return "normal";
  if (roll < 6) return "income";
  if (roll < 8) return "conversion";
  return "cost";
}
