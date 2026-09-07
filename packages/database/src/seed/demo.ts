import { Prisma } from "../generated/client/client.js";
import { getPrismaClient, ensureSyncStates, upsertCatalogEntries } from "../index.js";
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
  { category: "city_bank", label: "City bank deposit", min: 100_000, max: 800_000 },
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
  for (const state of await db.syncState.findMany({ where: { userId: user.id } })) {
    await db.syncState.update({
      where: { id: state.id },
      data: {
        status: "idle",
        lastSuccessAt: new Date(now * 1000),
        lastAttemptAt: new Date(now * 1000),
        lastCompletedAt: new Date(now * 1000),
        recordsCollected: between(500, 5000),
        nextRunAt: new Date((now + state.frequencySeconds) * 1000),
      },
    });
  }

  const itemIdByName = new Map<number, string>();

  /* ------------------------ item catalog (market prices) ----------------- */
  await upsertCatalogEntries(db, [
    ...DRUGS.map((d) => ({ itemId: d.itemId, name: d.name, type: "Drug", marketPrice: BigInt(d.price) })),
    ...PLUSHIES.map((p) => ({ itemId: p.itemId, name: p.name, type: "Plushie", marketPrice: BigInt(p.market) })),
    ...FLOWERS.map((f) => ({ itemId: f.itemId, name: f.name, type: "Flower", marketPrice: BigInt(f.market) })),
  ]);

  /* ---------------------------- drug events ------------------------------ */
  const drugRows = [];
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
      itemIdByName.set(drug.itemId, drug.name);
    }
  }
  await db.drugEvent.createMany({ data: drugRows });

  /* --------------------------- rehab events ------------------------------ */
  const rehabRows = [];
  for (let t = start; t < now; t += DAY * between(6, 12)) {
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
  const moneyRows = [];
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
  }
  await db.moneyEvent.createMany({ data: moneyRows, skipDuplicates: true });

  /* ------------------------- networth snapshots -------------------------- */
  let base = 180_000_000;
  const nwRows = [];
  for (let t = start; t < now; t += HOUR) {
    base = Math.max(50_000_000, base + between(-400_000, 560_000));
    nwRows.push({
      userId: user.id,
      capturedAt: new Date(t * 1000),
      total: BigInt(base),
      wallet: BigInt(Math.round(base * 0.08)),
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
        factionId: DEMO_FACTION_ID,
        opponentFactionId: 8800 + i,
        opponentName: w.opponent,
        startedAt: new Date(w.started * 1000),
        endedAt: new Date((w.started + w.days * DAY) * 1000),
        winnerFactionId: w.win ? DEMO_FACTION_ID : 8800 + i,
        targetScore: Math.max(w.our, w.their),
        ourScore: w.our,
        opponentScore: w.their,
        source: "demo",
        raw: { simulated: true, factions: [{ id: DEMO_FACTION_ID, name: "DEMO Syndicate", score: w.our }, { id: 8800 + i, name: w.opponent, score: w.their }] },
      },
      update: {},
    });
    // Personal payout inside the settlement tail (time-window match).
    await db.moneyEvent.createMany({
      data: [
        {
          userId: user.id,
          occurredAt: new Date((w.started + (w.days + 1) * DAY) * 1000),
          category: "faction",
          subcategory: "Faction payout money receive",
          direction: "income",
          amount: BigInt(Math.round(w.payout * 0.08)),
          source: "demo",
          sourceRef: `demo:war-payout:${w.id}`,
          description: "Faction payout money receive",
          metadata: { simulated: true, warId: w.id },
        },
      ],
      skipDuplicates: true,
    });
  }

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
