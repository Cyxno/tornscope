/**
 * Client-side category labels. Every cash-flow label states what the money
 * IS — "Item Market sales" (cash received) is a different concept from
 * "Items" (inventory value) and must never share a bare "Items" label.
 * Mirrors the server-side CASH_*_LABELS in @tornscope/analytics.
 */

export const INCOME_CATEGORY_LABELS: Record<string, string> = {
  salary: "Salary",
  crime: "Crime cash",
  mugging: "Muggings",
  ranked_war: "Ranked war payouts",
  faction: "Faction income",
  missions: "Missions",
  casino: "Casino",
  bazaar: "Bazaar sales",
  items: "Item Market sales",
  trading: "Trade proceeds",
  auction: "Auction proceeds",
  points: "Points sold",
  stock: "Stock sales",
  travel: "Travel goods sold",
  plushie: "Plushie sales",
  flower: "Flower sales",
  drugs: "Drug sales",
  other: "Other received",
};

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  rehab: "Rehab",
  education: "Education",
  hospital: "Hospital",
  jail: "Bail / jail",
  housing: "Property upkeep",
  bazaar: "Bazaar purchases",
  items: "Item Market purchases",
  trading: "Trade payments",
  auction: "Auction bids",
  points: "Points bought",
  stock: "Stock purchases",
  travel: "Travel goods bought",
  plushie: "Plushies bought",
  flower: "Flowers bought",
  drugs: "Drugs bought",
  other: "Other spending",
};

export function incomeLabel(category: string): string {
  return INCOME_CATEGORY_LABELS[category] ?? category;
}

export function expenseLabel(category: string): string {
  return EXPENSE_CATEGORY_LABELS[category] ?? category;
}
