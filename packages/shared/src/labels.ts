/**
 * ONE canonical human-label source.
 *
 * Every user-facing label that originates from a backend slug (enum value,
 * DB category, API key) must go through these explicit mappings. Pages must
 * never title-case or raw-render backend strings themselves.
 *
 * Casing policy: Title Case for category/group labels; official Torn item
 * names are preserved as-is by callers (item names never pass through here).
 * Plural for group nouns that represent many items (Plushies, Flowers);
 * singular is never shown as a category.
 */

/** Canonical category labels (context-free). */
export const CANONICAL_LABELS: Record<string, string> = {
  crime: "Crime",
  mugging: "Muggings",
  ranked_war: "Ranked War",
  faction: "Faction",
  travel: "Travel Goods",
  plushie: "Plushies",
  flower: "Flowers",
  xanax: "Xanax",
  drugs: "Drugs",
  stock: "Stocks",
  rehab: "Rehab",
  items: "Item Market",
  casino: "Casino",
  points: "Points",
  trading: "Trades",
  bazaar: "Bazaar",
  city_bank: "City Bank",
  cayman_bank: "Cayman Bank",
  piggy_bank: "Piggy Bank",
  bank_investment: "Bank Investment",
  faction_balance: "Faction Balance",
  salary: "Salary",
  education: "Education",
  hospital: "Hospital",
  jail: "Jail",
  housing: "Property",
  gym: "Gym",
  auction: "Auctions",
  missions: "Missions",
  other: "Other",
  weapon: "Weapons",
  vehicle: "Vehicles",
  armor: "Armor",
  booster: "Boosters",
  medical: "Medical Items",
  energy: "Energy Drinks",
  candy: "Candy",
  happy_jump: "Happy Items",
  temporary: "Temporary Items",
  drug_pack: "Drug Packs",
};

/** Finance context: cash RECEIVED labels (noun phrases, sales-oriented). */
export const INCOME_LABELS: Record<string, string> = {
  salary: "Salary",
  crime: "Crime Cash",
  mugging: "Muggings",
  ranked_war: "Ranked War Payouts",
  faction: "Faction Income",
  missions: "Missions",
  casino: "Casino",
  bazaar: "Bazaar Sales",
  items: "Item Market Sales",
  trading: "Trade Proceeds",
  auction: "Auction Proceeds",
  points: "Points Sold",
  stock: "Stock Sales",
  travel: "Travel Goods Sold",
  plushie: "Plushie Sales",
  flower: "Flower Sales",
  drugs: "Drug Sales",
  other: "Other Received",
};

/** Finance context: cash SPENT labels. */
export const EXPENSE_LABELS: Record<string, string> = {
  rehab: "Rehab",
  education: "Education",
  hospital: "Hospital",
  jail: "Bail / Jail",
  housing: "Property Rent & Upkeep",
  gym: "Gym Membership",
  bazaar: "Bazaar Purchases",
  items: "Item Market Purchases",
  trading: "Trade Payments",
  auction: "Auction Bids",
  points: "Points Bought",
  stock: "Stock Purchases",
  travel: "Travel Goods Bought",
  plushie: "Plushies Bought",
  flower: "Flowers Bought",
  drugs: "Drugs Bought",
  crime: "Crime",
  mugging: "Muggings",
  casino: "Casino",
  faction: "Faction",
  other: "Other Spending",
};

/** Last resort for unknown slugs: split separators and title-case each word.
 *  Known domain terms must be added to CANONICAL_LABELS instead. */
function titleCaseSlug(slug: string): string {
  return slug
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

/** Canonical label for a backend slug. Never returns an all-lowercase slug
 *  for known terms; unknown slugs get deterministic Title Case. */
export function humanLabel(slug: string): string {
  const explicit = CANONICAL_LABELS[slug];
  if (explicit) return explicit;
  if (slug === slug.toLowerCase() && slug.includes("_")) return titleCaseSlug(slug);
  return slug;
}

/** Cash-received context label (falls back to the canonical map). */
export function incomeLabel(category: string): string {
  return INCOME_LABELS[category] ?? humanLabel(category);
}

/** Cash-spent context label (falls back to the canonical map). */
export function expenseLabel(category: string): string {
  return EXPENSE_LABELS[category] ?? humanLabel(category);
}
