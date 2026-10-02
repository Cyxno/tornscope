import { getPrismaClient } from "../client.js";
import type { Prisma } from "../generated/client/client.js";
import {
  COMBAT_OPPONENTS,
  DAY,
  DESTINATIONS,
  DRUGS,
  EXPENSE_SEEDS,
  FLOWERS,
  HOUR,
  MONEY_SEEDS,
  PLUSHIES,
  dayKindFor,
  type DemoDayKind,
} from "./constants.js";
import { rngFor, utcDayNumber, type DemoRng } from "./random.js";

/**
 * The ONE synthetic demo history generator (V1.0 demo freshness).
 *
 * Both the full seed (packages/database/src/seed/demo.ts) and the routine
 * incremental top-up (demo/topup.ts) call this — one synthetic model that
 * cannot drift. All randomness is bucketed per (family, UTC day) via
 * demo/random.ts, so the same day generates identical rows in any window:
 * partial runs, reruns and catch-ups converge (idempotent sourceRefs +
 * skipDuplicates on every unique target).
 *
 * Semantics preserved from the original seed:
 *   - wallet cash is DERIVED from the recorded ledger movements + a tiny
 *     unexplained drift (demo behaves like real data: a small reconciliation
 *     residual, never an exact fake match);
 *   - drug uses produce matching ConsumptionEvents (same derivation the real
 *     normalizer performs) — no double counting, catalog price first with a
 *     per-row synthetic fallback, global TornItemCatalog NEVER written;
 *   - rehab costs are mirrored into the ledger exactly once;
 *   - energy is a simulated state machine (Xanax +250 up to the absolute
 *     1,000 cap, no natural-cap clipping; refills clamp to the natural cap);
 *     BarsSnapshot records it and stat gains land on the first hourly
 *     snapshot after each training burst ends;
 *   - travel lifecycle is strictly depart → arrive → buy → return; only
 *     fully returned trips are generated (the historic "stops 2 days before
 *     now" gap is gone — trips continue up to the present);
 *   - day archetypes exercise the wealth-first financial semantics: some
 *     days convert cash into assets (net worth ~flat while cash dips), some
 *     burn true costs (wealth down), some earn (wealth up).
 */

export interface DemoContinuationState {
  userId: string;
  /** The hour the wallet/base values are already tracked THROUGH (a snapshot
   *  at hour H includes hour H's movement). The walk resumes at H + 1h. */
  nwCapturedSec: number;
  /** Last NetworthSnapshot.total (seed of the wealth walk). */
  nwBase: number;
  /** Last NetworthSnapshot.wallet (tracked by the ledger). */
  wallet: number;
  /** Last PersonalStatSnapshot battle stats. */
  stats: { str: number; def: number; spd: number; dex: number };
  /** Cumulative PersonalStatSnapshot counters. */
  cum: { xanax: number; ecstasy: number; refills: number; candy: number; awards: number; overdoses: number };
  /** Last BarsSnapshot energy/happy. */
  energy: number;
  happy: number;
  /** Earliest time the demo account can depart on its next trip. */
  travelCursor: number;
  /** Timestamp (sec) after which the history generator may produce rows. */
  fromSec: number;
}

export interface DemoGeneratorOptions {
  userId: string;
  /** Window start (inclusive; aligned internally to the UTC hour). */
  fromSec: number;
  /** Window end (exclusive). */
  toSec: number;
  state: DemoContinuationState;
  /** Grid offset for training bursts / snapshot alignment (now % 3600). */
  gridOffset: number;
  /** Real catalog price when available, else the synthetic fallback. */
  xanaxUnitPrice: bigint;
  /** UTC day numbers where random personal Xanax is suppressed (the full
   *  seed's signature day fixes its own sponsored-Xanax evidence; random
   *  personal uses would blur the armory sponsorship matching). */
  reserveXanaxDays?: readonly number[];
  /** UTC day number that anchors the happy-jump cadence (the seed anchors
   *  it to the day BEFORE the signature day so any recent 3-day window
   *  demonstrates the jump inference). */
  jumpAnchorDay?: number;
  /** Bars-simulation window start (defaults to fromSec; the original full
   *  seed only simulated the last 10 days). */
  barsFromSec?: number;
  /** Personal-stat snapshot window start (defaults to fromSec; the seed
   *  used 30 days). */
  statsFromSec?: number;
  /** Extra money rows generated OUTSIDE this window (full-seed signature
   *  day + war payouts): included in wallet tracking and timeline mirrors,
   *  never re-inserted. */
  presetMoneyRows?: DemoMoneyRow[];
}

export interface DemoMoneyRow {
  userId: string;
  occurredAt: Date;
  category: string;
  subcategory?: string | null;
  direction: "income" | "expense" | "neutral";
  amount: bigint;
  source: string;
  sourceRef: string;
  description: string;
  metadata?: { demo?: boolean; simulated?: boolean; warId?: number; data?: { scenario?: string } };
}

export interface DemoGenerationResult {
  counts: Record<string, number>;
  state: DemoContinuationState;
}

const chunk = async <T>(db: ReturnType<typeof getPrismaClient>, rows: T[], insert: (batch: T[]) => Promise<unknown>, batch = 4_000): Promise<number> => {
  for (let i = 0; i < rows.length; i += batch) {
    await insert(rows.slice(i, i + batch));
  }
  return rows.length;
};

/** "demo:auto" marks routine top-up rows (distinct from the full seed's
 *  "demo:" refs) so ops can tell generated-tail rows from seed-time rows. */
const REF_PREFIX = "demo:auto";

export async function generateDemoHistory(db: ReturnType<typeof getPrismaClient>, opts: DemoGeneratorOptions): Promise<DemoGenerationResult> {
  const { userId, gridOffset, xanaxUnitPrice } = opts;
  const from = Math.floor(opts.fromSec / HOUR) * HOUR; // hour-aligned window
  const to = opts.toSec;
  const state: DemoContinuationState = { ...opts.state, stats: { ...opts.state.stats }, cum: { ...opts.state.cum } };

  const firstDay = utcDayNumber(from);
  const lastDay = utcDayNumber(to - 1);
  const counts: Record<string, number> = {};

  /* ------------------------- per-day planning pass ----------------------- */
  // Deterministic per-day content, computed BEFORE insertion so families can
  // reference each other (rehab cost mirrors to money; drug Xanax feeds the
  // energy simulation; bursts drive stats).
  type PlannedDrug = { occurredAt: number; drug: (typeof DRUGS)[number]; overdose: boolean; ref: string };
  type PlannedRehab = { occurredAt: number; cost: number; ref: string; sessions: number; percent: number; removed: number };
  type PlannedTravel = { departedAt: number; arrivedAt: number; returnedAt: number; destination: string; duration: number; items: Array<{ item: (typeof PLUSHIES | typeof FLOWERS)[number]; qty: number; unitCost: number; occurredAt: number; category: "plushie" | "flower" }> };
  const plannedDrugs: PlannedDrug[] = [];
  const plannedRehabs: PlannedRehab[] = [];
  const plannedTravels: PlannedTravel[] = [];
  const moneyRows: DemoMoneyRow[] = [...(opts.presetMoneyRows ?? [])];
  const plannedCrimes: Array<{ occurredAt: number; ref: string; success: boolean; nerve: number; money: number | null; itemsValue: number | null; jail: number | null; name: string; category: string }> = [];
  const plannedCombat: Array<{ occurredAt: number; ref: string; incoming: boolean; opponent: (typeof COMBAT_OPPONENTS)[number]; respect: number }> = [];
  const tornEventDays: number[] = [];

  // Travel chain: deterministic per link (each link derives from the previous
  // cursor), so any window generates the same chain prefix (Phase: travel).
  // The chain is DETERMINISTIC PER LINK: the gap after each trip derives
  // from that trip's returnedAt (which is what a rerun can read back from
  // the DB), so any rerun from the stored cursor re-derives the exact same
  // next departure — interrupted runs converge, never duplicate.
  let travelCursor = state.travelCursor;
  while (travelCursor + 8 * HOUR < to) {
    const gap = rngFor("travelgap", travelCursor).between(2, 30) * HOUR;
    const departedAt = travelCursor + gap + 8 * HOUR;
    const destRng = rngFor("travel", departedAt);
    const dest = destRng.pick(DESTINATIONS);
    const abroadHours = destRng.between(dest.flightHours + 4, dest.flightHours + 40);
    const returnedAt = departedAt + (abroadHours + dest.flightHours) * HOUR;
    if (returnedAt >= to - HOUR) break; // only fully returned trips
    const items: PlannedTravel["items"] = [];
    if (destRng.chance(0.55)) {
      const item = destRng.pick(PLUSHIES);
      items.push({ item, qty: destRng.between(4, 30), unitCost: Math.round(item.market * (0.62 + destRng.next() * 0.25)), occurredAt: departedAt + destRng.between(1, abroadHours) * HOUR, category: "plushie" });
    }
    if (destRng.chance(0.5)) {
      const item = destRng.pick(FLOWERS);
      items.push({ item, qty: destRng.between(4, 30), unitCost: Math.round(item.market * (0.62 + destRng.next() * 0.25)), occurredAt: departedAt + destRng.between(1, abroadHours) * HOUR, category: "flower" });
    }
    plannedTravels.push({ departedAt, arrivedAt: departedAt + dest.flightHours * HOUR, returnedAt, destination: dest.name, duration: returnedAt - departedAt, items });
    travelCursor = returnedAt;
  }

  for (let day = firstDay; day <= lastDay; day++) {
    const dayStart = day * DAY;
    const kind: DemoDayKind = dayKindFor(day);
    const drugRng = rngFor("drug", day);
    const moneyRng = rngFor("money", day);
    const rehabRng = rngFor("rehab", day);
    const miscRng = rngFor("misc", day);

    // Drugs (~3 attempts/day, 55% hit — as the original seed). Reserved
    // days still roll the RNG (same draw count) but never produce Xanax.
    for (let i = 0; i < 3; i++) {
      if (!drugRng.chance(0.55)) continue;
      const drug = drugRng.weightedPick(DRUGS);
      if (drug.name === "Xanax" && opts.reserveXanaxDays?.includes(day)) {
        continue;
      }
      const overdose = drugRng.chance(0.035);
      const at = dayStart + drugRng.between(0, 23) * HOUR + drugRng.between(0, HOUR - 1);
      if (at >= to) continue; // never generate the future
      plannedDrugs.push({ occurredAt: at, drug, overdose, ref: `${REF_PREFIX}:drug:${day}:${i}` });
    }

    // Rehab: cost days always run a session cluster; otherwise rare.
    const rehabToday = kind === "cost" ? true : rehabRng.chance(0.02);
    if (rehabToday) {
      const at = dayStart + 14 * HOUR;
      const cost = rehabRng.between(80_000, 900_000);
      const percent = rehabRng.weightedPick([{ weight: 4, value: 20 }, { weight: 3, value: 40 }, { weight: 2, value: 60 }, { weight: 1, value: 80 }]).value;
      const removed = rehabRng.between(40, 140);
      if (at < to) {
        plannedRehabs.push({ occurredAt: at, cost, ref: `${REF_PREFIX}:rehab:${day}`, sessions: rehabRng.between(2, 4), percent, removed });
        moneyRows.push({ userId, occurredAt: new Date(at * 1000), category: "rehab", direction: "expense", amount: -BigInt(cost), source: "demo", sourceRef: `${REF_PREFIX}:rehabmoney:${day}`, description: "Drug rehabilitation paid" });
      }
    }

    // Money ledger for the day (hourly flow + day-kind economics).
    for (let h = 0; h < 24; h++) {
      const hourStart = dayStart + h * HOUR;
      const incomeP = kind === "income" ? 0.7 : kind === "cost" ? 0.3 : 0.55;
      const expenseP = kind === "cost" ? 0.7 : 0.5;
      const perHour = moneyRng.chance(0.4) ? 1 : 2;
      for (let i = 0; i < perHour; i++) {
        const at = hourStart + moneyRng.between(0, HOUR - 1);
        if (at >= to) continue; // never generate the future
        if (moneyRng.chance(incomeP)) {
          const seed = moneyRng.weightedPick(MONEY_SEEDS);
          moneyRows.push({ userId, occurredAt: new Date(at * 1000), category: seed.category, subcategory: null, direction: "income", amount: BigInt(moneyRng.between(seed.min, seed.max)), source: "demo", sourceRef: `${REF_PREFIX}:money:${day}:${h}:${i}`, description: seed.label });
        }
        if (moneyRng.chance(expenseP)) {
          const seed = moneyRng.pick(EXPENSE_SEEDS);
          moneyRows.push({ userId, occurredAt: new Date(at * 1000), category: seed.category, subcategory: null, direction: "expense", amount: -BigInt(moneyRng.between(seed.min, seed.max)), source: "demo", sourceRef: `${REF_PREFIX}:moneyexp:${day}:${h}:${i}`, description: seed.label });
        }
      }
    }
    if (kind === "income") {
      // Salary lands at 08:15 — real wealth growth (fixture-D shape).
      if (dayStart + 8 * HOUR < to) moneyRows.push({ userId, occurredAt: new Date((dayStart + 8 * HOUR + 15 * 60) * 1000), category: "salary", direction: "income", amount: 365_000n, source: "demo", sourceRef: `${REF_PREFIX}:salary:${day}`, description: "Salary money receive" });
    }
    if (kind === "conversion") {
      // Large matched buy+sell: cash dips while asset value absorbs it — the
      // "movement, not loss" acceptance shape (fixture-A/E).
      const convRng = rngFor("conversion", day);
      const buys = convRng.between(1, 2);
      for (let i = 0; i < buys; i++) {
        const at = dayStart + convRng.between(9, 16) * HOUR;
        moneyRows.push({ userId, occurredAt: new Date(at * 1000), category: "items", direction: "expense", amount: -BigInt(convRng.between(800_000, 2_500_000)), source: "demo", sourceRef: `${REF_PREFIX}:assetbuy:${day}:${i}`, description: "Bought weapons & armor" });
      }
      for (let i = 0; i < buys; i++) {
        const at = dayStart + convRng.between(12, 22) * HOUR;
        moneyRows.push({ userId, occurredAt: new Date(at * 1000), category: "trading", direction: "income", amount: BigInt(convRng.between(700_000, 2_400_000)), source: "demo", sourceRef: `${REF_PREFIX}:assetsell:${day}:${i}`, description: "Item sale" });
      }
    }
    if (kind === "cost") {
      const costRng = rngFor("costday", day);
      for (let i = 0; i < 2; i++) {
        const at = dayStart + costRng.between(10, 21) * HOUR;
        moneyRows.push({ userId, occurredAt: new Date(at * 1000), category: costRng.chance(0.5) ? "gym" : "housing", direction: "expense", amount: -BigInt(costRng.between(150_000, 3_200_000)), source: "demo", sourceRef: `${REF_PREFIX}:truecost:${day}:${i}`, description: costRng.chance(0.5) ? "Gym paid" : "Property rent paid" });
      }
    }
    // Same-day bank conversion pair (invest morning, withdraw evening with a
    // small proportional yield) — deterministic per day, no cross-day state.
    // (Density ~0.35/day mirrors the original seed's per-hour rolls.)
    if (moneyRng.chance(0.35) && dayStart + 20 * HOUR < to) {
      const invest = moneyRng.between(200_000, 2_000_000);
      const yieldPct = moneyRng.between(4, 12) / 10_000; // ~0.04–0.12% same-day
      moneyRows.push({ userId, occurredAt: new Date((dayStart + 9 * HOUR) * 1000), category: "city_bank", subcategory: null, direction: "neutral", amount: -BigInt(invest), source: "demo", sourceRef: `${REF_PREFIX}:bankdep:${day}`, description: "Bank invest" });
      moneyRows.push({ userId, occurredAt: new Date((dayStart + 20 * HOUR) * 1000), category: "city_bank", subcategory: null, direction: "neutral", amount: BigInt(invest + Math.round((invest * yieldPct))) + BigInt(1), source: "demo", sourceRef: `${REF_PREFIX}:bankwd:${day}`, description: "Bank withdraw" });
    }

    // Combat + crimes: occasional, day-scoped (no index-based refs).
    const crimeCount = miscRng.between(0, 2);
    for (let i = 0; i < crimeCount; i++) {
      const crimeAt = dayStart + miscRng.between(0, 23) * HOUR + miscRng.between(0, HOUR - 1);
      if (crimeAt >= to) continue; // never generate the future
      const success = !miscRng.chance(1 / 3);
      plannedCrimes.push({
        occurredAt: crimeAt,
        ref: `${REF_PREFIX}:crime:${day}:${i}`,
        success,
        nerve: 2 + miscRng.between(0, 3),
        money: success && miscRng.chance(0.25) ? miscRng.between(40_000, 900_000) : null,
        itemsValue: success && miscRng.chance(0.2) ? miscRng.between(9_500, 60_000) : null,
        jail: !success && miscRng.chance(0.12) ? 3_600 : null,
        name: miscRng.chance(0.5) ? "copying DVDs" : "shoplifting from the Jewelry Store",
        category: miscRng.chance(0.5) ? "legacy" : "new",
      });
    }
    const combatCount = miscRng.between(0, 2);
    for (let i = 0; i < combatCount; i++) {
      const at = dayStart + miscRng.between(0, 23) * HOUR + miscRng.between(0, HOUR - 1);
      if (at >= to) continue; // never generate the future
      plannedCombat.push({
        occurredAt: at,
        ref: `${REF_PREFIX}:attack:${day}:${i}`,
        incoming: miscRng.chance(1 / 9),
        opponent: miscRng.pick(COMBAT_OPPONENTS),
        respect: Math.round((1.5 + miscRng.between(0, 9) / 10) * 10) / 10,
      });
    }
    tornEventDays.push(day);
  }

  /* ------------------------------ insertion ------------------------------ */
  const realPriceFallback = new Map<number, bigint>(DRUGS.map((d) => [d.itemId as number, BigInt(d.price)]));
  const priceOf = (itemId: number, fallback: number): bigint => (itemId === 206 ? xanaxUnitPrice : realPriceFallback.get(itemId) ?? BigInt(fallback));

  const drugRows = plannedDrugs.map((d) => ({
    userId, occurredAt: new Date(d.occurredAt * 1000), drugItemId: d.drug.itemId, drugName: d.drug.name,
    outcome: d.overdose ? ("overdose" as const) : ("success" as const), source: "demo", sourceRef: d.ref,
  }));
  const drugConsumptionRows = plannedDrugs.filter((d) => !d.overdose).map((d) => {
    const unit = priceOf(d.drug.itemId, d.drug.price);
    return {
      userId, occurredAt: new Date(d.occurredAt * 1000), itemId: d.drug.itemId, itemName: d.drug.name,
      category: "drug", quantity: 1, unitValue: unit, totalValue: unit,
      valuationMethod: "catalog_market_price", provenance: "estimated", source: "derived_drug_event",
      sourceRef: d.ref, metadata: { demo: true },
    };
  });
  counts.drugs = await chunk(db, drugRows, (b) => db.drugEvent.createMany({ data: b, skipDuplicates: true }));
  counts.consumptions = await chunk(db, drugConsumptionRows, (b) => db.consumptionEvent.createMany({ data: b, skipDuplicates: true }));

  counts.rehabs = await chunk(db, plannedRehabs.map((r) => ({
    userId, occurredAt: new Date(r.occurredAt * 1000), rehabPercent: r.percent, cost: BigInt(r.cost),
    sessions: r.sessions, addictionPointsRemoved: r.removed, source: "demo", sourceRef: r.ref,
  })), (b) => db.rehabEvent.createMany({ data: b, skipDuplicates: true }));

  let travelInserts = 0;
  for (const t of plannedTravels) {
    // Chained lifecycle rows: keep the per-trip create (items need the FK),
    // idempotent via the unique sourceRef.
    const existing = await db.travelEvent.findUnique({ where: { userId_source_sourceRef: { userId, source: "demo", sourceRef: `${REF_PREFIX}:travel:${t.departedAt}` } }, select: { id: true } });
    if (existing) continue;
    const travelEvent = await db.travelEvent.create({
      data: {
        userId, destination: t.destination, departedAt: new Date(t.departedAt * 1000), arrivedAt: new Date(t.arrivedAt * 1000),
        returnedAt: new Date(t.returnedAt * 1000), durationSeconds: t.duration, status: "returned", source: "demo",
        sourceRef: `${REF_PREFIX}:travel:${t.departedAt}`,
      },
    });
    for (const item of t.items) {
      await db.travelItemEvent.create({
        data: {
          userId, travelEventId: travelEvent.id, occurredAt: new Date(item.occurredAt * 1000), destination: t.destination,
          category: item.category, itemId: item.item.itemId, itemName: item.item.name, quantity: item.qty,
          unitCost: BigInt(item.unitCost), totalCost: BigInt(item.unitCost * item.qty),
          estimatedUnitValue: BigInt(item.item.market), estimatedTotalValue: BigInt(item.item.market * item.qty),
          source: "demo", sourceRef: `${REF_PREFIX}:travelitem:${item.item.itemId}:${t.departedAt}`,
        },
      });
      travelInserts++;
    }
  }
  counts.travels = travelInserts;

  // Money events are inserted AFTER the networth pass below: the walk may
  // append wallet top-up rows (bank withdrawals) that must be part of the
  // ledger — wallet and ledger can never diverge.

  // Combat + crimes.
  counts.combat = await chunk(db, plannedCombat.map((c) => ({
    userId, occurredAt: new Date(c.occurredAt * 1000), direction: c.incoming ? ("incoming" as const) : ("outgoing" as const),
    opponentId: c.opponent[0], opponentName: c.opponent[1], result: c.opponent[2], respectDelta: c.respect,
    modifiers: { simulated: true }, sourceRef: c.ref, metadata: { simulated: true },
  })), (b) => db.combatEvent.createMany({ data: b, skipDuplicates: true }));
  counts.crimes = await chunk(db, plannedCrimes.map((c) => ({
    userId, occurredAt: new Date(c.occurredAt * 1000), crimeId: 1000 + (hashish(c.ref) % 12),
    crimeName: c.name, crimeCategory: c.category, success: c.success, nerveUsed: c.nerve,
    moneyDelta: c.money !== null ? BigInt(c.money) : null,
    itemsValue: c.itemsValue !== null ? BigInt(c.itemsValue) : null,
    jailSeconds: c.jail, hospitalSeconds: null, skillGain: null, sourceRef: c.ref, metadata: { simulated: true },
  })), (b) => db.crimeEvent.createMany({ data: b, skipDuplicates: true }));

  /* --------------------- networth snapshots (tracked) -------------------- */
  // Wallet derives from the ledger; OC-scenario rows are excluded (they
  // credit the faction balance, not the wallet) — same rule as the seed.
  const movementByHour = new Map<number, number>();
  for (const row of moneyRows) {
    if ((row.metadata as { data?: { scenario?: string } } | null)?.data?.scenario) continue;
    const h = Math.floor(row.occurredAt.getTime() / 1000 / HOUR) * HOUR;
    movementByHour.set(h, (movementByHour.get(h) ?? 0) + Number(row.amount));
  }
  const nwRows = [];
  let base = state.nwBase;
  let wallet = state.wallet;
  const WALLET_FLOOR = 2_000_000;
  // Resume AFTER the hour the base snapshot already tracked (a snapshot at
  // hour H includes hour H's movement) — otherwise an overlapping rerun
  // double-counts the overlap stretch into newly inserted rows.
  const nwWalkFrom = Math.max(from, state.nwCapturedSec + HOUR);
  // For ALREADY-COVERED hours (overlap reruns), the walk follows the STORED
  // ledger reality — never regenerated in-memory amounts — so reruns and
  // interrupted runs always converge on what is already committed.
  const storedMoveByHour = new Map<number, number>();
  const storedEndSec = Math.min(to, state.nwCapturedSec + HOUR);
  if (storedEndSec > from) {
    const storedRows = await db.moneyEvent.findMany({
      where: { userId, occurredAt: { gte: new Date(from * 1000), lt: new Date(storedEndSec * 1000) } },
      select: { occurredAt: true, amount: true },
    });
    for (const r of storedRows) {
      const h = Math.floor(r.occurredAt.getTime() / 1000 / HOUR) * HOUR;
      storedMoveByHour.set(h, (storedMoveByHour.get(h) ?? 0) + Number(r.amount));
    }
  }
  for (let t = nwWalkFrom; t < to; t += HOUR) {
    const day = utcDayNumber(t);
    const kind = dayKindFor(day);
    const walk = rngFor("nw", t);
    const bias = kind === "income" ? walk.between(150_000, 650_000) : kind === "cost" ? -walk.between(120_000, 620_000) : kind === "conversion" ? walk.between(-80_000, 380_000) : walk.between(-400_000, 560_000);
    base = Math.max(50_000_000, base + bias);
    const covered = t <= state.nwCapturedSec;
    let moved: number;
    if (covered) {
      moved = storedMoveByHour.get(t) ?? 0;
    } else {
      moved = movementByHour.get(t) ?? 0;
      // Cash top-up (NEW hours only): when the recorded ledger would run the
      // wallet dry, the demo account withdraws from its bank — a NEUTRAL
      // conversion recorded IN the ledger, so wallet and ledger stay
      // structurally coherent (no silent clipping, no fake residual).
      if (wallet + moved < WALLET_FLOOR) {
        const topUp = WALLET_FLOOR - (wallet + moved) + walk.between(0, 100_000);
        const at = t + walk.between(0, HOUR - 1);
        moneyRows.push({ userId, occurredAt: new Date(at * 1000), category: "city_bank", subcategory: null, direction: "neutral", amount: BigInt(Math.round(topUp)), source: "demo", sourceRef: `${REF_PREFIX}:banktopup:${t}`, description: "Bank withdraw" });
        moved += topUp;
        movementByHour.set(t, moved);
      }
    }
    const drift = Math.round((walk.next() - 0.5) * 12_000);
    wallet = Math.max(1_000_000, wallet + moved + drift);
    nwRows.push({
      userId, capturedAt: new Date(t * 1000), total: BigInt(Math.round(base)), wallet: BigInt(Math.round(wallet)),
      vault: BigInt(Math.round(base * 0.02)), cityBank: BigInt(Math.round(base * 0.3)), caymanBank: BigInt(Math.round(base * 0.12)),
      points: BigInt(Math.round(base * 0.1)), inventory: BigInt(Math.round(base * 0.15)), displayCase: BigInt(Math.round(base * 0.03)),
      bazaar: BigInt(Math.round(base * 0.04)), itemMarket: BigInt(Math.round(base * 0.05)), property: BigInt(Math.round(base * 0.08)),
      stockMarket: BigInt(Math.round(base * 0.03)), company: BigInt(0), raw: { demo: true },
    });
  }
  counts.networth = await chunk(db, nwRows, (b) => db.networthSnapshot.createMany({ data: b, skipDuplicates: true }));

  // Money events — inserted AFTER the networth pass so the walk's wallet
  // top-up rows (bank withdrawals) are part of the ledger: wallet and
  // ledger can never diverge. Preset rows first (full-seed signature day +
  // war payouts), then the generated flow; uniques make reruns no-ops.
  counts.money = await chunk(db, moneyRows, (b) => db.moneyEvent.createMany({ data: b, skipDuplicates: true }));
  if (nwRows.length > 0) {
    state.nwBase = Number(nwRows[nwRows.length - 1]!.total);
    state.wallet = Number(nwRows[nwRows.length - 1]!.wallet);
  }

  /* --------------- progression: energy simulation + stats ---------------- */
  const barsFrom = Math.max(from, opts.barsFromSec ?? from);
  const statsFrom = Math.max(from, opts.statsFromSec ?? from);
  // Bars and stat snapshots share the burst grid (gridOffset), exactly like
  // the original seed: a burst drains within bar steps and its stat gain
  // lands on the first snapshot at/after the burst end — adjacent bracket.
  //
  // ANCHOR FIRST, THEN APPLY THE OFFSET — exactly once. `barsFrom`/
  // `statsFrom` derive from `now - N*DAY`, which already carries the seed
  // moment's sub-hour phase; adding gridOffset on top rotated the snapshot
  // grid to phase 2*gridOffset while bursts sit at phase gridOffset. For a
  // band of seed wall-clock phases the hourly snapshot then landed INSIDE
  // the training bracket carrying pre-gain stats, so the bracket delta was
  // zero, every session degraded to "possible" and summary.energyTrained
  // came out 0 — deterministic per seed time (CI vs local 1.0.1 divergence).
  const barsFromAligned = barsFrom - (barsFrom % 300) + (gridOffset % 300);
  const statsStart = statsFrom - (statsFrom % HOUR) + (gridOffset % HOUR);

  // Training bursts per day (grid-anchored like the seed): 08:00 always;
  // 19:00 on every third UTC day; the 19:00 burst is a HAPPY JUMP on days
  // ≡ 4 (mod 9) — complete with ecstasy/xanax/refill/EDVD evidence.
  const bursts: Array<{ from: number; to: number; jump?: boolean }> = [];
  const simXanax: Array<{ at: number }> = [];
  const simEcstasy: Array<{ at: number; happy: number }> = [];
  const simRefills: Array<{ at: number; energy: number }> = [];
  const simEdvd: Array<{ at: number }> = [];
  for (let day = utcDayNumber(barsFromAligned); day <= lastDay; day++) {
    const dayStart = day * DAY;
    bursts.push({ from: dayStart + 8 * HOUR + gridOffset + 180, to: dayStart + 8 * HOUR + gridOffset + 1680 });
    // Every third evening (anchored to the day before the signature day)
    // trains twice — the evening session is a HAPPY JUMP (ecstasy + double
    // Xanax + refill + EDVD evidence) — so any recent 3-day window
    // demonstrates the jump inference, matching the original seed's
    // always-jump-yesterday guarantee at continuous density.
    const anchor = opts.jumpAnchorDay;
    const isJumpDay = anchor === undefined ? day % 3 === 0 : (((day - anchor) % 3) + 3) % 3 === 0;
    if (isJumpDay) {
      bursts.push({ from: dayStart + 19 * HOUR + gridOffset + 180, to: dayStart + 19 * HOUR + gridOffset + 1680, jump: true });
      const prep = dayStart + 18 * HOUR + gridOffset;
      simEcstasy.push({ at: prep, happy: 6250 });
      simXanax.push({ at: prep + 5 * 60 }, { at: prep + 20 * 60 });
      simRefills.push({ at: dayStart + 19 * HOUR + gridOffset + 300, energy: 150 });
      simEdvd.push({ at: prep + 2 * 60 });
    } else if (day % 3 === 0) {
      bursts.push({ from: dayStart + 19 * HOUR + gridOffset + 180, to: dayStart + 19 * HOUR + gridOffset + 1680 });
    }
  }
  // Xanax from the generated random drug rows feeds the simulation too.
  for (const d of plannedDrugs) {
    if (d.drug.name === "Xanax" && !d.overdose && d.occurredAt >= barsFromAligned) simXanax.push({ at: d.occurredAt });
  }
  simXanax.sort((a, b) => a.at - b.at);

  let energy = state.energy;
  let happy = state.happy;
  const energyMax = 150;
  const happyMax = 5000;
  const clamp = (v: number, max: number): number => Math.max(0, Math.min(max, v));
  const barsRng = rngFor("bars", from, to);
  const barsRows = [];
  for (let t = barsFromAligned; t < to; t += 300) {
    energy = clamp(energy + 1, energyMax); // natural regen: 1 / 5 min
    happy = clamp(happy + 2, happyMax);
    for (const e of simEcstasy) if (e.at >= t && e.at < t + 300) happy = clamp(happy + e.happy, happyMax);
    for (const e of simEdvd) if (e.at >= t && e.at < t + 300) happy = clamp(happy + 1500, happyMax);
    for (const e of simXanax) if (e.at >= t && e.at < t + 300) energy = Math.min(energy + 250, 1000);
    for (const e of simRefills) if (e.at >= t && e.at < t + 300) energy = clamp(energy + e.energy, energyMax);
    for (const burst of bursts) {
      if (t >= burst.from && t < burst.to) {
        energy = clamp(energy - (burst.jump ? 30 : 28), energyMax);
        if (burst.jump) happy = clamp(happy - 20, happyMax);
      }
    }
    if (barsRng.chance(0.004)) energy = clamp(energy - barsRng.between(30, 60), energyMax);
    barsRows.push({ userId, capturedAt: new Date(t * 1000), energyCurrent: Math.round(energy), energyMaximum: energyMax, happyCurrent: Math.round(happy), happyMaximum: happyMax });
  }
  counts.bars = await chunk(db, barsRows, (b) => db.barsSnapshot.createMany({ data: b, skipDuplicates: true }));
  if (barsRows.length > 0) {
    const last = barsRows[barsRows.length - 1]!;
    state.energy = Number(last.energyCurrent);
    state.happy = Number(last.happyCurrent);
  }

  // Evidence rows for simulation inputs (refill timeline, xanax/ecstasy drug
  // rows, EDVD consumption) — same derivation as the seed.
  await chunk(db, simRefills.map((e) => ({
    userId, occurredAt: new Date(e.at * 1000), type: "log", category: "Points building", title: "Points energy refill use",
    description: null, amount: null, source: "demo", sourceRef: `${REF_PREFIX}:refill:${e.at}`,
    metadata: { id: e.at, timestamp: e.at, details: { id: 0, title: "Points energy refill use", category: "Points building" }, data: { points_used: 30, energy_increased: e.energy } },
  })), (b) => db.timelineEvent.createMany({ data: b, skipDuplicates: true }));
  await chunk(db, simXanax.map((e) => ({
    userId, occurredAt: new Date(e.at * 1000), drugItemId: 206, drugName: "Xanax", outcome: "success" as const,
    source: "demo", sourceRef: `${REF_PREFIX}:progxanax:${e.at}`,
  })), (b) => db.drugEvent.createMany({ data: b, skipDuplicates: true }));
  await chunk(db, simEcstasy.map((e) => ({
    userId, occurredAt: new Date(e.at * 1000), drugItemId: 200, drugName: "Ecstasy", outcome: "success" as const,
    source: "demo", sourceRef: `${REF_PREFIX}:progecstasy:${e.at}`,
  })), (b) => db.drugEvent.createMany({ data: b, skipDuplicates: true }));
  await chunk(db, simEdvd.map((e) => ({
    userId, occurredAt: new Date(e.at * 1000), itemId: 470, itemName: "Erotic DVD", category: "happy_jump", quantity: 1,
    valuationMethod: "unknown", provenance: "unknown", source: "demo", sourceRef: `${REF_PREFIX}:edvd:${e.at}`,
  })), (b) => db.consumptionEvent.createMany({ data: b, skipDuplicates: true }));

  // 2.1.0 deep-analytics evidence: gym train logs (exact energy_used), Xanax
  // OD log rows (exact energy_decreased) and a light archive mix (hunting,
  // bank, casino) so the Energy page and the Log Explorer render with the
  // same payload shapes Torn writes. Deterministic via the same rngFor seed.
  // rng is seeded per UTC DAY (the top-up family contract): a watermark-rewound rerun covers an overlap with a DIFFERENT window, so window-keyed chance() decisions would not replay identically.
  const STAT_KEYS = ["strength", "defense", "speed", "dexterity"] as const;
  type LogRow = Prisma.TimelineEventCreateManyInput;
  const gymRows: LogRow[] = [];
  for (const burst of bursts) {
    const share = [0.4, 0.25, 0.2, 0.15];
    const total = burst.jump ? 250 : 140;
    STAT_KEYS.forEach((stat, i) => {
      const at = burst.from + i * 4 * 60;
      const used = Math.round(total * share[i]!);
      gymRows.push({
        userId, occurredAt: new Date(at * 1000), type: "log", category: "Gym", title: `Gym train ${stat}`,
        description: null, amount: null, source: "demo", sourceRef: `${REF_PREFIX}:gym:${burst.from}:${stat}`,
        metadata: { id: at, timestamp: at, details: { id: 0, title: `Gym train ${stat}`, category: "Gym" }, data: { gym: 24, trains: Math.round(used / 10), happy_used: Math.round(used * 0.5), energy_used: used } },
      });
    });
  }
  counts.gymLogs = await chunk(db, gymRows, (b) => db.timelineEvent.createMany({ data: b, skipDuplicates: true }));

  const odLogs = plannedDrugs
    .filter((d) => d.overdose && d.drug.name === "Xanax")
    .map((d) => ({
      userId, occurredAt: new Date(d.occurredAt * 1000), type: "log", category: "Drugs", title: "Item use xanax overdose",
      description: null, amount: null, source: "demo", sourceRef: `${d.ref}:odlog`,
      metadata: { id: d.occurredAt, timestamp: d.occurredAt, details: { id: 0, title: "Item use xanax overdose", category: "Drugs" }, data: { item: 206, faction: 0, happy_decreased: 5000, nerve_decreased: 5, energy_decreased: 150, hospital_time_increased: 300000 } },
    }));
  await chunk(db, odLogs, (b) => db.timelineEvent.createMany({ data: b, skipDuplicates: true }));

  const archiveRows: LogRow[] = [];
  for (let day = utcDayNumber(barsFromAligned); day <= lastDay; day++) {
    const dayStart = day * DAY;
    const deepRng = rngFor("deep-logs", day);
    if (deepRng.chance(0.5)) {
      const at = dayStart + 12 * HOUR + deepRng.between(0, 3600);
      const cost = 500;
      const income = deepRng.between(500, 15000);
      archiveRows.push({
        userId, occurredAt: new Date(at * 1000), type: "log", category: "Hunting", title: "Hunting",
        description: null, amount: null, source: "demo", sourceRef: `${REF_PREFIX}:hunt:${day}`,
        metadata: { id: at, timestamp: at, details: { id: 0, title: "Hunting", category: "Hunting" }, data: { cost, income, session_type: "a beginners hunting session", hunting_skill: "56.781", hunting_skill_gain: "and gained 0.0865 hunting skill" } },
      });
    }
    if (deepRng.chance(0.4)) {
      const at = dayStart + 20 * HOUR + deepRng.between(0, 3600);
      const money = deepRng.between(5000, 60000);
      archiveRows.push({
        userId, occurredAt: new Date(at * 1000), type: "log", category: "Bank", title: "Bank withdraw",
        description: null, amount: null, source: "demo", sourceRef: `${REF_PREFIX}:banklog:${day}`,
        metadata: { id: at, timestamp: at, details: { id: 0, title: "Bank withdraw", category: "Bank" }, data: { money } },
      });
    }
  }
  await chunk(db, archiveRows, (b) => db.timelineEvent.createMany({ data: b, skipDuplicates: true }));

  /* ------------------------- personal stat snapshots --------------------- */
  const statRows = [];
  let { str, def, spd, dex } = state.stats;
  const { xanax: cumXanax, ecstasy: cumEcstasy, overdoses } = state.cum;
  let { refills: cumRefills, candy: cumCandy, awards: cumAwards } = state.cum;
  const statRng = rngFor("stats", from, to);
  for (let t = statsStart; t < to; t += HOUR) {
    const day = utcDayNumber(t);
    for (const burst of bursts) {
      // First hourly snapshot at/after the burst end — same bracket rule as
      // the seed, so session attribution sees a clean [before, after].
      if (t >= burst.to && t - HOUR < burst.to) {
        const g = burst.jump
          ? { str: 2_500_000, def: 180_000, spd: 260_000, dex: 150_000 }
          : { str: statRng.between(40_000, 52_000), def: statRng.between(4_000, 6_000), spd: statRng.between(5_000, 7_000), dex: statRng.between(3_000, 5_000) };
        str += g.str; def += g.def; spd += g.spd; dex += g.dex;
      }
    }
    if (new Date(t * 1000).getUTCHours() === 7) {
      cumRefills += statRng.chance(0.35) ? 1 : 0;
      cumCandy += statRng.between(0, 3);
      if (statRng.chance(0.02)) cumAwards += 1;
    }
    // Cumulative counters only count simulation events UP TO this snapshot —
    // a past snapshot must never include future evidence rows.
    const xanaxSoFar = simXanax.filter((e) => e.at <= t).length;
    const ecstasySoFar = simEcstasy.filter((e) => e.at <= t).length;
    const refillsSoFar = simRefills.filter((e) => e.at <= t).length;
    statRows.push({
      userId, capturedAt: new Date(t * 1000), networthTotal: null,
      stats: {
        battle_stats: { strength: Math.round(str), defense: Math.round(def), speed: Math.round(spd), dexterity: Math.round(dex), total: Math.round(str + def + spd + dex) },
        drugs: { xanax: cumXanax + xanaxSoFar, ecstasy: cumEcstasy + ecstasySoFar, total: cumXanax + xanaxSoFar + cumEcstasy + ecstasySoFar, overdoses },
        other: { refills: { energy: cumRefills + refillsSoFar, nerve: 0, token: 0 }, awards: cumAwards },
        items: { used: { candy: cumCandy, boosters: 1, energy_drinks: 0 } },
        level: 42,
      },
    });
  }
  counts.stats = await chunk(db, statRows, (b) => db.personalStatSnapshot.createMany({ data: b, skipDuplicates: true }));
  if (statRows.length > 0) {
    const lastStats = statRows[statRows.length - 1]!.stats as {
      battle_stats: { strength: number; defense: number; speed: number; dexterity: number };
      drugs: { xanax: number; ecstasy: number; overdoses: number };
      other: { refills: { energy: number }; awards: number };
      items: { used: { candy: number } };
    };
    state.stats = { str: lastStats.battle_stats.strength, def: lastStats.battle_stats.defense, spd: lastStats.battle_stats.speed, dex: lastStats.battle_stats.dexterity };
    state.cum = { ...state.cum, xanax: lastStats.drugs.xanax, ecstasy: lastStats.drugs.ecstasy, refills: lastStats.other.refills.energy, candy: lastStats.items.used.candy, awards: lastStats.other.awards, overdoses: lastStats.drugs.overdoses };
  }

  /* ------------------------------- timeline ------------------------------ */
  // Mirrors of the SAME underlying events (never phantom timeline-only rows).
  const timelineRows = [
    ...moneyRows.map((row) => ({
      userId, occurredAt: row.occurredAt, type: "log", category: `Money ${row.category}`,
      title: row.description ?? "Money event", description: null, amount: row.amount, source: "demo", sourceRef: row.sourceRef,
    })),
    ...plannedDrugs.map((d) => ({
      userId, occurredAt: new Date(d.occurredAt * 1000), type: "log", category: "Item use drug",
      title: `${d.overdose ? "Overdosed on" : "Used"} ${d.drug.name}`, description: null, amount: null,
      source: "demo", sourceRef: d.ref,
    })),
    ...tornEventDays.map((day) => {
      const r = rngFor("torney", day);
      return {
        userId, occurredAt: new Date((day * DAY + r.between(0, DAY - 1)) * 1000), type: "torn_event", category: null,
        title: r.pick(["You won a ranked war match!", "You were awarded a medal", "A bounty on your head was claimed", "You leveled up!"]),
        description: null, amount: null, source: "demo", sourceRef: `${REF_PREFIX}:event:${day}`,
      };
    }),
  ];
  counts.timeline = await chunk(db, timelineRows, (b) => db.timelineEvent.createMany({ data: b, skipDuplicates: true }));

  state.travelCursor = travelCursor;
  state.fromSec = to;
  return { counts, state };
}

/** Small stable string hash for crime-id variety (deterministic per ref). */
function hashish(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
