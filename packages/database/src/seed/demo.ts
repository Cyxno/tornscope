import { Prisma } from "../generated/client/client.js";
import { getPrismaClient, ensureSyncStates } from "../index.js";
import { DEMO_USER_EMAIL } from "@tornscope/shared";

/**
 * Demo mode: generates synthetic historical data for a dedicated demo user.
 * Demo data is NEVER mixed with a real player's account (separate User row
 * with isDemo = true, fake Torn id, name prefixed "DEMO").
 *
 * Run with: pnpm seed:demo
 */

const DEMO_TORN_ID = 2_000_000_001;

const DAY = 86_400;
const HOUR = 3600;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260904);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const between = (min: number, max: number) => Math.floor(min + rand() * (max - min));

const DRUGS = [
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

const DESTINATIONS = [
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

const PLUSHIES = [
  { name: "Teddy Bear Plushie", itemId: 445, market: 26_000 },
  { name: "Kitten Plushie", itemId: 449, market: 24_000 },
  { name: "Jaguar Plushie", itemId: 457, market: 90_000 },
  { name: "Nessie Plushie", itemId: 473, market: 55_000 },
  { name: "Red Fox Plushie", itemId: 468, market: 38_000 },
] as const;

const FLOWERS = [
  { name: "Ceibo Blossom", itemId: 265, market: 18_000 },
  { name: "Edelweiss", itemId: 262, market: 60_000 },
  { name: "Cherry Blossom", itemId: 260, market: 27_000 },
  { name: "Peony", itemId: 263, market: 22_000 },
  { name: "African Violet", itemId: 276, market: 20_000 },
] as const;

const MONEY_SEEDS = [
  { category: "crime", label: "Crime payout", min: 5_000, max: 120_000, weight: 6 },
  { category: "mugging", label: "Mugged a player", min: 2_000, max: 90_000, weight: 3 },
  { category: "ranked_war", label: "Ranked war payout", min: 40_000, max: 400_000, weight: 1 },
  { category: "casino", label: "Casino win", min: 1_000, max: 250_000, weight: 2 },
  { category: "stock", label: "Stock dividend", min: 10_000, max: 60_000, weight: 1 },
  { category: "trading", label: "Item sale", min: 5_000, max: 300_000, weight: 3 },
] as const;

const EXPENSE_SEEDS = [
  { category: "points", label: "Bought 100 points", min: 45_000, max: 52_000 },
  { category: "items", label: "Bought weapons & armor", min: 10_000, max: 400_000 },
  { category: "bazaar", label: "Bazaar restock", min: 5_000, max: 150_000 },
  { category: "housing", label: "Property rent paid", min: 20_000, max: 80_000 },
] as const;

function weightedPick<T extends { weight: number }>(items: readonly T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let roll = rand() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1]!;
}

async function main(): Promise<void> {
  const db = getPrismaClient();

  // Fresh demo data on every seed run (never touches real users).
  await db.user.deleteMany({ where: { email: DEMO_USER_EMAIL } });

  const now = Math.floor(Date.now() / 1000);
  const start = now - 180 * DAY;

  const user = await db.user.create({
    data: { email: DEMO_USER_EMAIL, displayName: "Demo Player", role: "owner", isDemo: true },
  });

  await db.tornAccount.create({
    data: {
      userId: user.id,
      tornId: DEMO_TORN_ID,
      isDemo: true,
      name: "DEMO_Player",
      level: 42,
      rank: "Bravo",
      donatorStatus: 2,
      gender: "Male",
      property: "Apartment with a penthouse",
      factionId: 9999,
      firstSeenAt: new Date(start * 1000),
      lastSeenAt: new Date(now * 1000),
    },
  });

  const faction = await db.faction.upsert({
    where: { id: 9999 },
    create: { id: 9999, name: "DEMO Syndicate", tag: "DEMO", respect: 4200, daysOld: 900, capacity: 100, members: 87, bestChain: 1051 },
    update: {},
  });

  await db.factionMembership.create({
    data: { userId: user.id, factionId: faction.id, joinedAt: new Date((start - 300 * DAY) * 1000), isActive: true, sourceRef: "demo" },
  });

  await ensureSyncStates(db, user.id);
  // History-walk resources get internally consistent fabricated coverage:
  // their backward walks count as finished (source exhausted), which the
  // data-confidence derivation reads as a complete synthetic dataset.
  const walkResources = new Set(["drugs", "rehab", "money_logs", "travel", "events", "attacks"]);
  for (const state of await db.syncState.findMany({ where: { userId: user.id } })) {
    await db.syncState.update({
      where: { id: state.id },
      data: {
        status: "idle",
        lastSuccessAt: new Date(now * 1000),
        lastAttemptAt: new Date(now * 1000),
        lastCompletedAt: new Date(now * 1000),
        recordsCollected: between(500, 5000),
        ...(walkResources.has(state.resource) ? { stopReason: "source_exhausted" as const, lastTimestamp: BigInt(now) } : {}),
        nextRunAt: new Date((now + state.frequencySeconds) * 1000),
      },
    });
  }

  const itemIdByName = new Map<number, string>();

  /* ------------------------ item catalog (market prices) ----------------- */
  // ISOLATION: TornItemCatalog is a GLOBAL table shared by every profile, so
  // the demo seed must NEVER write to it — its synthetic prices (e.g. Xanax
  // at $45k) would overwrite real Torn market prices for production
  // analytics. Demo reads whatever the real catalog holds; the demo's own
  // consumption rows carry explicit per-row values below.

  /* ---------------------------- drug events ------------------------------ */
  // Each use also produces a consumption event (same derivation the real
  // normalizer performs) so Drugs and Economy can never contradict each
  // other in the demo dataset.
  const demoItemIds = [...DRUGS.map((d) => d.itemId), ...PLUSHIES.map((p) => p.itemId), ...FLOWERS.map((f) => f.itemId)];
  const catalogRows = await db.tornItemCatalog.findMany({ where: { itemId: { in: demoItemIds } }, select: { itemId: true, marketPrice: true } });
  const realPrices = new Map<number, bigint>(catalogRows.filter((r) => r.marketPrice !== null).map((r) => [r.itemId, r.marketPrice as bigint]));
  const drugRows = [];
  const drugConsumptionRows = [];
  for (let t = start; t < now; t += HOUR * 8) {
    if (rand() < 0.55) {
      const drug = weightedPick(DRUGS);
      const overdose = rand() < 0.035;
      drugRows.push({
        userId: user.id,
        occurredAt: new Date((t + between(0, HOUR)) * 1000),
        drugItemId: drug.itemId,
        drugName: drug.name,
        outcome: overdose ? ("overdose" as const) : ("success" as const),
        source: "demo",
        sourceRef: `demo:drug:${t}`,
      });
      const catalogPrice = realPrices.get(drug.itemId);
      const unitPrice = catalogPrice ?? BigInt(drug.price);
      drugConsumptionRows.push({
        userId: user.id,
        occurredAt: new Date((t + between(0, HOUR)) * 1000),
        itemId: drug.itemId,
        itemName: drug.name,
        category: "drug",
        quantity: 1,
        unitValue: unitPrice,
        totalValue: unitPrice,
        valuationMethod: "catalog_market_price",
        provenance: "estimated",
        source: "derived_drug_event",
        sourceRef: `demo:drug:${t}`,
        metadata: { demo: true },
      });
      itemIdByName.set(drug.itemId, drug.name);
    }
  }
  await db.drugEvent.createMany({ data: drugRows });
  await db.consumptionEvent.createMany({ data: drugConsumptionRows, skipDuplicates: true });

  /* --------------------------- rehab events ------------------------------ */
  const rehabRows = [];
  for (let t = start; t < now; t += DAY * between(6, 12)) {
    const sessions = between(2, 4);
    rehabRows.push({
      userId: user.id,
      occurredAt: new Date(t * 1000),
      rehabPercent: weightedPick([
        { weight: 4, value: 20 },
        { weight: 3, value: 40 },
        { weight: 2, value: 60 },
        { weight: 1, value: 80 },
      ]).value,
      cost: BigInt(between(80_000, 900_000)),
      sessions,
      addictionPointsRemoved: between(40, 140),
      source: "demo",
      sourceRef: `demo:rehab:${t}`,
    });
  }
  await db.rehabEvent.createMany({ data: rehabRows });

  /* -------------------------- travel + items ----------------------------- */
  let cursor = start;
  while (cursor < now - 2 * DAY) {
    const dest = pick(DESTINATIONS);
    const departedAt = cursor + 8 * HOUR;
    const abroadHours = between(dest.flightHours + 4, dest.flightHours + 40);
    const returnedAt = departedAt + (abroadHours + dest.flightHours) * HOUR;

    const travelEvent = await db.travelEvent.create({
      data: {
        userId: user.id,
        destination: dest.name,
        departedAt: new Date(departedAt * 1000),
        arrivedAt: new Date((departedAt + dest.flightHours * HOUR) * 1000),
        returnedAt: new Date(returnedAt * 1000),
        durationSeconds: (returnedAt - departedAt),
        status: "returned",
        source: "demo",
        sourceRef: `demo:travel:${departedAt}`,
      },
    });

    const wantPlushies = rand() < 0.55;
    const wantFlowers = rand() < 0.5;
    const catalog = [...(wantPlushies ? [pick(PLUSHIES)] : []), ...(wantFlowers ? [pick(FLOWERS)] : [])];

    for (const item of catalog) {
      const qty = between(4, 30);
      const unitCost = Math.round(item.market * (0.62 + rand() * 0.25));
      await db.travelItemEvent.create({
        data: {
          userId: user.id,
          travelEventId: travelEvent.id,
          occurredAt: new Date((departedAt + between(1, abroadHours) * HOUR) * 1000),
          destination: dest.name,
          category: PLUSHIES.some((p) => p.itemId === item.itemId) ? "plushie" : "flower",
          itemId: item.itemId,
          itemName: item.name,
          quantity: qty,
          unitCost: BigInt(unitCost),
          totalCost: BigInt(unitCost * qty),
          estimatedUnitValue: BigInt(item.market),
          estimatedTotalValue: BigInt(item.market * qty),
          source: "demo",
          sourceRef: `demo:travelitem:${item.itemId}:${departedAt}`,
        },
      });
      itemIdByName.set(item.itemId, item.name);
    }

    cursor = returnedAt + between(2, 30) * HOUR;
  }

  /* ---------------------------- money ledger ----------------------------- */
  // The signature day's deterministic money rows are seeded HERE (not in the
  // signature-day section below) so the networth snapshots below can track
  // them like real data would.
  const sigStart = Math.floor(now / DAY) * DAY - DAY; // UTC midnight, yesterday
  const sig = (h: number, m = 0): Date => new Date((sigStart + h * HOUR + m * 60) * 1000);
  const sigMoneyRows = [
    { userId: user.id, occurredAt: sig(2, 15), category: "salary", direction: "income" as const, amount: 365_000n, source: "demo", sourceRef: "demo:sig:salary", description: "Salary money receive" },
    // Bazaar sale: big cash inflow, but an asset conversion — never profit.
    { userId: user.id, occurredAt: sig(9, 40), category: "bazaar", direction: "income" as const, amount: 2_400_000n, source: "demo", sourceRef: "demo:sig:bazaarsale", description: "Bazaar sale money receive" },
    // Stock purchase: cash → asset (conversion, not an expense).
    { userId: user.id, occurredAt: sig(11, 5), category: "stock", direction: "expense" as const, amount: -1_500_000n, source: "demo", sourceRef: "demo:sig:stockbuy", description: "Stock buy money sent" },
    // Bank investment then withdrawal WITH yield: deposit leaves the wallet
    // (neutral), the withdrawal returns principal + interest — the interest
    // portion must surface only as derived economic income, never as raw cash income.
    { userId: user.id, occurredAt: sig(11, 20), category: "city_bank", direction: "neutral" as const, amount: -500_000n, source: "demo", sourceRef: "demo:sig:bankdep", description: "Bank invest" },
    { userId: user.id, occurredAt: sig(21, 45), category: "city_bank", direction: "neutral" as const, amount: 521_000n, source: "demo", sourceRef: "demo:sig:bankwd", description: "Bank withdraw" },
    // Gym upgrade: a true expense where existing semantics say so.
    { userId: user.id, occurredAt: sig(18, 30), category: "gym", direction: "expense" as const, amount: -75_000n, source: "demo", sourceRef: "demo:sig:gym", description: "Gym paid" },
    // Rehab cost mirrored to the ledger (same as the real normalizer).
    { userId: user.id, occurredAt: sig(14, 10), category: "rehab", direction: "expense" as const, amount: -250_000n, source: "demo", sourceRef: "demo:sig:rehab", description: "Drug rehabilitation paid" },
    // Rental extension ACCEPTANCE (renter side): true expense, actual rent.
    { userId: user.id, occurredAt: sig(16, 5), category: "housing", direction: "expense" as const, amount: -3_200_000n, source: "demo", sourceRef: "demo:sig:rent", description: "Property rental market extension accept renter", subcategory: "Property rental market extension accept renter" },
    // OC payout: earned income credited to the FACTION MEMBER BALANCE —
    // exercises the scenario-metadata exclusion from wallet flows (it must
    // NOT move the wallet, or the bridge reports a phantom gap).
    { userId: user.id, occurredAt: sig(15, 0), category: "faction", direction: "income" as const, amount: 1_200_000n, source: "demo", sourceRef: "demo:sig:ocpayout", description: "Faction payout money balance receive", subcategory: "Faction payout money balance receive", metadata: { demo: true, data: { scenario: "Break the Bank" } } },
  ];
  await db.moneyEvent.createMany({ data: sigMoneyRows, skipDuplicates: true });

  type DemoMoneyRow = {
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
  };
  const moneyRows: DemoMoneyRow[] = [...sigMoneyRows];
  for (let t = start; t < now; t += HOUR) {
    const perHour = rand() < 0.4 ? 1 : 2;
    for (let i = 0; i < perHour; i++) {
      const at = t + between(0, HOUR);
      if (rand() < 0.55) {
        const seed = weightedPick(MONEY_SEEDS);
        moneyRows.push({
          userId: user.id,
          occurredAt: new Date(at * 1000),
          category: seed.category,
          subcategory: null,
          direction: "income" as const,
          amount: BigInt(between(seed.min, seed.max)),
          source: "demo",
          sourceRef: `demo:money:${at}:${i}`,
          description: seed.label,
        });
      }
      if (rand() < 0.5) {
        const seed = pick(EXPENSE_SEEDS);
        moneyRows.push({
          userId: user.id,
          occurredAt: new Date(at * 1000),
          category: seed.category,
          subcategory: null,
          direction: "expense" as const,
          amount: -BigInt(between(seed.min, seed.max)),
          source: "demo",
          sourceRef: `demo:moneyexp:${at}:${i}`,
          description: seed.label,
        });
      }
    }
    // Occasional bank transfer pair: invest, then withdraw with ~4% yield —
    // exercises the conversion lens and the derived bank-interest split.
    // Pairs continue right up to `now` so every window keeps matched pairs;
    // a withdrawal whose invest falls outside the analyzed window is
    // conservatively unattributable interest (the honest case the analytics
    // must also handle).
    if (rand() < 0.02) {
      const invest = between(200_000, 2_000_000);
      const interest = Math.round(invest * 0.04);
      moneyRows.push({
        userId: user.id,
        occurredAt: new Date((t + between(0, HOUR)) * 1000),
        category: "city_bank",
        subcategory: null,
        direction: "neutral" as const,
        amount: -BigInt(invest),
        source: "demo",
        sourceRef: `demo:bankdep:${t}`,
        description: "Bank invest",
      });
      moneyRows.push({
        userId: user.id,
        occurredAt: new Date(Math.min(t + between(24, 240) * HOUR, now - HOUR) * 1000),
        category: "city_bank",
        subcategory: null,
        direction: "neutral" as const,
        amount: BigInt(invest + interest),
        source: "demo",
        sourceRef: `demo:bankwd:${t}`,
        description: "Bank withdraw",
      });
    }
  }
  await db.moneyEvent.createMany({ data: moneyRows, skipDuplicates: true });

  /* ------------------ ranked wars + personal payouts --------------------- */
  // Seeded BEFORE the networth snapshots so the payouts are part of the
  // wallet-tracking ledger below (a recorded payout that never reached the
  // tracked wallet would fabricate a phantom reconciliation residual).
  const DEMO_WAR_FACTION_ID = 9999;
  const warRows = [
    { id: 9001, opponent: "DEMO Rivals", started: now - 90 * DAY, days: 5, win: true, our: 12_000, their: 8_500, payout: 8_000_000 },
    { id: 9002, opponent: "DEMO Warriors", started: now - 60 * DAY, days: 4, win: true, our: 15_200, their: 9_100, payout: 12_500_000 },
    { id: 9003, opponent: "DEMO Titans", started: now - 30 * DAY, days: 6, win: false, our: 7_400, their: 16_800, payout: 2_000_000 },
    { id: 9004, opponent: "DEMO Wolves", started: now - 10 * DAY, days: 5, win: true, our: 18_300, their: 11_000, payout: 15_000_000 },
  ];
  for (const [i, w] of warRows.entries()) {
    await db.rankedWar.upsert({
      where: { tornWarId: w.id },
      create: {
        tornWarId: w.id,
        factionId: DEMO_WAR_FACTION_ID,
        opponentFactionId: 8800 + i,
        opponentName: w.opponent,
        startedAt: new Date(w.started * 1000),
        endedAt: new Date((w.started + w.days * DAY) * 1000),
        winnerFactionId: w.win ? DEMO_WAR_FACTION_ID : 8800 + i,
        targetScore: Math.max(w.our, w.their),
        ourScore: w.our,
        opponentScore: w.their,
        source: "demo",
        raw: { simulated: true, factions: [{ id: DEMO_WAR_FACTION_ID, name: "DEMO Syndicate", score: w.our }, { id: 8800 + i, name: w.opponent, score: w.their }] },
      },
      update: {},
    });
    // Personal payout inside the settlement tail (time-window match) —
    // wallet cash, tracked by the snapshots below (no scenario metadata).
    moneyRows.push({
      userId: user.id,
      occurredAt: new Date((w.started + (w.days + 1) * DAY) * 1000),
      category: "faction",
      subcategory: "Faction payout money receive",
      direction: "income" as const,
      amount: BigInt(Math.round(w.payout * 0.08)),
      source: "demo",
      sourceRef: `demo:war-payout:${w.id}`,
      description: "Faction payout money receive",
      metadata: { simulated: true, warId: w.id },
    });
  }
  await db.moneyEvent.createMany({ data: moneyRows, skipDuplicates: true });

  /* ------------------------- networth snapshots -------------------------- */
  // Wallet cash is DERIVED from the recorded ledger movements plus a tiny
  // unexplained drift, so the demo's wallet reconciliation behaves like real
  // data: a small residual that analytics must surface, never a fake exact
  // match. OC payouts are excluded here (they credit the faction balance).
  // Buckets align to the SNAPSHOT grid (start + k*HOUR), not epoch hours —
  // the loop below steps on `start`-aligned hours.
  const movementByHour = new Map<number, number>();
  const hourOf = (sec: number): number => start + Math.floor((sec - start) / HOUR) * HOUR;
  for (const row of moneyRows) {
    if ((row.metadata as { data?: { scenario?: string } } | null)?.data?.scenario) continue;
    const h = hourOf(Math.floor(row.occurredAt.getTime() / 1000));
    movementByHour.set(h, (movementByHour.get(h) ?? 0) + Number(row.amount));
  }
  let base = 180_000_000;
  let wallet = 25_000_000;
  const nwRows = [];
  for (let t = start; t < now; t += HOUR) {
    base = Math.max(50_000_000, base + between(-400_000, 560_000));
    const moved = movementByHour.get(t) ?? 0;
    const drift = Math.round((rand() - 0.5) * 12_000); // the demo's small residual
    wallet = Math.max(1_000_000, wallet + moved + drift);
    nwRows.push({
      userId: user.id,
      capturedAt: new Date(t * 1000),
      total: BigInt(base),
      wallet: BigInt(wallet),
      vault: BigInt(Math.round(base * 0.02)),
      cityBank: BigInt(Math.round(base * 0.3)),
      caymanBank: BigInt(Math.round(base * 0.12)),
      points: BigInt(Math.round(base * 0.1)),
      inventory: BigInt(Math.round(base * 0.15)),
      displayCase: BigInt(Math.round(base * 0.03)),
      bazaar: BigInt(Math.round(base * 0.04)),
      itemMarket: BigInt(Math.round(base * 0.05)),
      property: BigInt(Math.round(base * 0.08)),
      stockMarket: BigInt(Math.round(base * 0.03)),
      company: BigInt(0),
      raw: { demo: true },
    });
  }
  await db.networthSnapshot.createMany({ data: nwRows, skipDuplicates: true });

  /* --------------------------- timeline events --------------------------- */
  const timelineRows = [
    ...drugRows.slice(-400).map((row) => ({
      userId: user.id,
      occurredAt: row.occurredAt,
      type: "log",
      category: "Item use drug",
      title: `${row.outcome === "overdose" ? "Overdosed on" : "Used"} ${row.drugName}`,
      description: null,
      amount: null,
      source: "demo",
      sourceRef: row.sourceRef,
    })),
    ...moneyRows.slice(-400).map((row) => ({
      userId: user.id,
      occurredAt: row.occurredAt,
      type: "log",
      category: `Money ${row.category}`,
      title: row.description ?? "Money event",
      description: null,
      amount: row.amount,
      source: "demo",
      sourceRef: row.sourceRef,
    })),
  ];
  await db.timelineEvent.createMany({ data: timelineRows, skipDuplicates: true });

  /* ------------------------------ torn events ---------------------------- */
  const tornEventRows = [];
  for (let t = start; t < now; t += DAY) {
    tornEventRows.push({
      userId: user.id,
      occurredAt: new Date((t + between(0, DAY)) * 1000),
      type: "torn_event",
      category: null,
      title: pick(["You won a ranked war match!", "You were awarded a medal", "A bounty on your head was claimed", "You leveled up!"]),
      description: null,
      amount: null,
      source: "demo",
      sourceRef: `demo:event:${t}`,
    });
  }
  await db.timelineEvent.createMany({ data: tornEventRows, skipDuplicates: true });

  // ---- Crimes & Combat (simulated, demo user only) ----
  const crimeRows = Array.from({ length: 240 }, (_, i) => {
    const ts = new Date((now - (i % 170) * DAY - (i % 7) * 3600) * 1000);
    const success = i % 3 !== 0;
    const money = success && i % 4 === 0 ? (i % 9) * 125_000 + 40_000 : null;
    return {
      userId: user.id,
      occurredAt: ts,
      crimeId: 1000 + (i % 12),
      crimeName: i % 2 === 0 ? "copying DVDs" : "shoplifting from the Jewelry Store",
      crimeCategory: i % 2 === 0 ? "legacy" : "new",
      success,
      nerveUsed: 2 + (i % 4),
      moneyDelta: money !== null ? BigInt(money) : null,
      itemsValue: success && i % 5 === 0 ? BigInt((i % 7) * 9_500) : null,
      jailSeconds: !success && i % 8 === 0 ? 3_600 : null,
      hospitalSeconds: null,
      skillGain: null,
      sourceRef: `demo:crime:${i}`,
      metadata: { simulated: true },
    };
  });
  await db.crimeEvent.createMany({ data: crimeRows, skipDuplicates: true });

  const opponents: Array<[number, string | null, string]> = [
    [777001, "DEMO_Rival", "Attacked"],
    [777002, "DEMO_Target", "Mugged"],
    [777003, "DEMO_Bully", "Lost"],
    [777004, "DEMO_Ghost", "Hospitalized"],
    [777005, null, "Attacked"],
  ];
  const combatRows = Array.from({ length: 120 }, (_, i) => {
    const ts = new Date((now - (i % 160) * DAY - (i % 5) * 5400) * 1000);
    const opponentTuple = opponents[i % opponents.length]!;
    const [opponentId, opponentName, result] = opponentTuple;
    const incoming = i % 9 === 0;
    return {
      userId: user.id,
      occurredAt: ts,
      direction: incoming ? "incoming" : "outgoing",
      opponentId: opponentId,
      opponentName: opponentName,
      result: result,
      respectDelta: i % 3 !== 0 ? 1.5 + (i % 10) / 10 : 0,
      modifiers: { simulated: true },
      sourceRef: `demo:attack:${i}`,
      metadata: { simulated: true },
    };
  });
  await db.combatEvent.createMany({ data: combatRows, skipDuplicates: true });

  // ---- Faction, ranked wars, chains, OCs (simulated, demo user only) ----
  const DEMO_FACTION_ID = 9999;
  await db.faction.upsert({
    where: { id: DEMO_FACTION_ID },
    create: { id: DEMO_FACTION_ID, name: "DEMO Syndicate", tag: "DEMO", respect: 250_000, daysOld: 400, capacity: 50, members: 12, bestChain: 420 },
    update: {},
  });
  await db.factionMembership.upsert({
    where: { userId_factionId_sourceRef: { userId: user.id, factionId: DEMO_FACTION_ID, sourceRef: "demo:member:2000000001" } },
    create: { userId: user.id, factionId: DEMO_FACTION_ID, sourceRef: "demo:member:2000000001", joinedAt: new Date((now - 120 * DAY) * 1000) },
    update: {},
  });

  /* ------------------------- signature day (yesterday) -------------------- */
  // A deterministic, coherent "yesterday" (UTC calendar day) so the Daily
  // Summary always has a day worth explaining: earned income, a true expense,
  // an asset conversion, an internal bank movement, a profitable abroad trip,
  // faction-sponsored Xanax, a rehab visit and notable account events. Fixed
  // hours keep it reproducible; every row stays user-scoped demo data and the
  // global item catalog is never touched.
  // (The signature day's MONEY rows are seeded in the money-ledger section
  // above so the networth snapshots can track them like real data would.)
  const xanaxItem = DRUGS.find((d) => d.name === "Xanax")!;
  const xanaxPriceNow = realPrices.get(xanaxItem.itemId) ?? BigInt(xanaxItem.price);

  // Two Xanax uses; the first is faction-sponsored (armory "used" evidence
  // within the matching tolerance), the second draws the armory batch below —
  // both land in confirmed_faction with a personal cost of exactly $0.
  await db.drugEvent.createMany({
    data: [
      { userId: user.id, occurredAt: sig(10, 0), drugItemId: xanaxItem.itemId, drugName: "Xanax", outcome: "success", source: "demo", sourceRef: "demo:sig:xanax1" },
      { userId: user.id, occurredAt: sig(22, 30), drugItemId: xanaxItem.itemId, drugName: "Xanax", outcome: "success", source: "demo", sourceRef: "demo:sig:xanax2" },
    ],
    skipDuplicates: true,
  });
  await db.consumptionEvent.createMany({
    data: [
      { userId: user.id, occurredAt: sig(10, 0), itemId: xanaxItem.itemId, itemName: "Xanax", category: "drug", quantity: 1, unitValue: xanaxPriceNow, totalValue: xanaxPriceNow, valuationMethod: "catalog_market_price", provenance: "estimated", source: "derived_drug_event", sourceRef: "demo:sig:xanax1" },
      { userId: user.id, occurredAt: sig(22, 30), itemId: xanaxItem.itemId, itemName: "Xanax", category: "drug", quantity: 1, unitValue: xanaxPriceNow, totalValue: xanaxPriceNow, valuationMethod: "catalog_market_price", provenance: "estimated", source: "derived_drug_event", sourceRef: "demo:sig:xanax2" },
    ],
    skipDuplicates: true,
  });
  await db.factionArmoryEvent.createMany({
    data: [
      { userId: user.id, factionId: DEMO_FACTION_ID, memberId: DEMO_TORN_ID, memberName: "DEMO_Player", itemId: xanaxItem.itemId, itemName: "Xanax", action: "used", quantity: 1, value: xanaxPriceNow, source: "demo", sourceRef: "demo:sig:armory-used", occurredAt: sig(10, 0) },
      { userId: user.id, factionId: DEMO_FACTION_ID, memberId: DEMO_TORN_ID, memberName: "DEMO_Player", itemId: xanaxItem.itemId, itemName: "Xanax", action: "lent", quantity: 2, value: xanaxPriceNow * 2n, source: "demo", sourceRef: "demo:sig:armory-lent", occurredAt: sig(-48) },
    ],
    skipDuplicates: true,
  });

  await db.rehabEvent.create({
    data: { userId: user.id, occurredAt: sig(14, 10), rehabPercent: 60, cost: 250_000n, sessions: 2, addictionPointsRemoved: 95, source: "demo", sourceRef: "demo:sig:rehab" },
  });

  // A completed abroad trip with purchases (catalog-estimated profit inputs).
  const sigDest = DESTINATIONS[0]!;
  const sigDeparted = sig(3);
  const sigArrived = sig(3 + sigDest.flightHours);
  const sigReturned = sig(12);
  const sigTrip = await db.travelEvent.create({
    data: {
      userId: user.id,
      destination: sigDest.name,
      departedAt: sigDeparted,
      arrivedAt: sigArrived,
      returnedAt: sigReturned,
      durationSeconds: Math.floor(sigReturned.getTime() / 1000) - Math.floor(sigDeparted.getTime() / 1000),
      status: "returned",
      source: "demo",
      sourceRef: "demo:sig:travel",
    },
  });
  const sigItem = PLUSHIES[0]!;
  const sigQty = 25;
  const sigUnitCost = Math.round(sigItem.market * 0.65);
  await db.travelItemEvent.create({
    data: {
      userId: user.id,
      travelEventId: sigTrip.id,
      occurredAt: sig(6),
      destination: sigDest.name,
      category: "plushie",
      itemId: sigItem.itemId,
      itemName: sigItem.name,
      quantity: sigQty,
      unitCost: BigInt(sigUnitCost),
      totalCost: BigInt(sigUnitCost * sigQty),
      estimatedUnitValue: BigInt(sigItem.market),
      estimatedTotalValue: BigInt(sigItem.market * sigQty),
      source: "demo",
      sourceRef: "demo:sig:travelitem",
    },
  });

  // Notable account events for the highlights list.
  await db.timelineEvent.createMany({
    data: [
      { userId: user.id, occurredAt: sig(9, 41), type: "torn_event", title: "You sold 25 items in your bazaar", description: "A significant bazaar sale completed.", source: "demo", sourceRef: "demo:sig:event-bazaar" },
      { userId: user.id, occurredAt: sig(19, 5), type: "torn_event", title: "You were admitted to hospital", description: "You were hospitalized for a short while.", source: "demo", sourceRef: "demo:sig:event-hospital" },
    ],
    skipDuplicates: true,
  });


  const chainRows = [
    { id: 9101, chain: 420, respect: 810.5, daysAgo: 75, hours: 3 },
    { id: 9102, chain: 260, respect: 420.2, daysAgo: 40, hours: 2 },
    { id: 9103, chain: 1_050, respect: 2_010.75, daysAgo: 12, hours: 5 },
  ];
  for (const c of chainRows) {
    await db.factionChain.upsert({
      where: { userId_chainId: { userId: user.id, chainId: c.id } },
      create: {
        userId: user.id,
        factionId: DEMO_FACTION_ID,
        chainId: c.id,
        chain: c.chain,
        respect: c.respect,
        startedAt: new Date((now - c.daysAgo * DAY) * 1000),
        endedAt: new Date((now - c.daysAgo * DAY + c.hours * 3600) * 1000),
      },
      update: {},
    });
  }

  const ocNames: Array<[string, string, number | null]> = [
    ["Thou Shalt Not Steal", "Successful", 1_332_000],
    ["Break the Bank", "Successful", 2_100_000],
    ["Human Trafficking", "Failure", null],
    ["Stage Fright", "Recruiting", null],
  ];
  for (const [i, [name, status, money]] of ocNames.entries()) {
    await db.organizedCrime.upsert({
      where: { userId_ocId: { userId: user.id, ocId: 9200 + i } },
      create: {
        userId: user.id,
        factionId: DEMO_FACTION_ID,
        ocId: 9200 + i,
        name,
        difficulty: 8,
        status,
        createdAt: new Date((now - (60 - i * 10) * DAY) * 1000),
        planningAt: new Date((now - (55 - i * 10) * DAY) * 1000),
        executedAt: status === "Recruiting" ? null : new Date((now - (50 - i * 10) * DAY) * 1000),
        readyAt: new Date((now - (48 - i * 10) * DAY) * 1000),
        expiredAt: null,
        rewards: status === "Successful" ? { money, respect: 60, payout: { type: "balance", percentage: 80 } } : Prisma.DbNull,
        slots: [
          { position: "Muscle", user: { id: DEMO_TORN_ID, outcome: status === "Successful" ? "Successful" : "Failure", progress: 100 } },
          { position: "Thief", user: null },
        ],
      },
      update: {},
    });
  }

  await db.factionBalanceSnapshot.create({
    data: {
      userId: user.id,
      factionId: DEMO_FACTION_ID,
      money: BigInt(480_000_000),
      points: 30,
      scope: 12,
      members: [{ id: DEMO_TORN_ID, username: "DEMO_Player", money: 9_000_000 }],
      capturedAt: new Date(now * 1000),
    },
  });

  const counts = {
    crimes: crimeRows.length,
    rankedWars: warRows.length,
    chains: chainRows.length,
    ocs: ocNames.length,
    combat: combatRows.length,
    drugs: drugRows.length,
    rehab: rehabRows.length,
    money: moneyRows.length,
    networth: nwRows.length,
    timeline: timelineRows.length + tornEventRows.length,
  };
  console.log(`Demo seed complete for user ${user.id}:`, JSON.stringify(counts));
  console.log("All rows are marked source='demo' for the isDemo=true user - never mixed with real players.");
}

main()
  .catch((err) => {
    console.error("Demo seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await getPrismaClient().$disconnect();
  });
