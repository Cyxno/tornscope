import { Prisma } from "../generated/client/client.js";
import { getPrismaClient, ensureSyncStates } from "../index.js";
import { DEMO_USER_EMAIL } from "@tornscope/shared";
import { DAY, DEMO_FACTION_ID, DEMO_TORN_ID, DRUGS, FLOWERS, PLUSHIES, DESTINATIONS, HOUR } from "../demo/constants.js";
import { generateDemoHistory, type DemoMoneyRow } from "../demo/generator.js";
import { DEMO_TOPUP_WATERMARK_KEY } from "../demo/topup.js";

/**
 * Demo mode: FULL SEED — destructive/reset-style, for initial setup and
 * manual recovery only (pnpm seed:demo). Routine freshness is the
 * incremental, non-destructive top-up (demo/topup.ts, `pnpm demo:topup`,
 * worker-scheduled every ≤6h) — both share the SAME generator in
 * demo/generator.ts so the synthetic model cannot drift.
 *
 * Demo data is NEVER mixed with a real player's account (separate User row
 * with isDemo = true, fake Torn id, name prefixed "DEMO"). The global
 * TornItemCatalog is never written; demo consumption rows carry explicit
 * per-row values.
 */

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
      factionId: DEMO_FACTION_ID,
      firstSeenAt: new Date(start * 1000),
      lastSeenAt: new Date(now * 1000),
    },
  });

  const faction = await db.faction.upsert({
    where: { id: DEMO_FACTION_ID },
    create: { id: DEMO_FACTION_ID, name: "DEMO Syndicate", tag: "DEMO", respect: 4200, daysOld: 900, capacity: 100, members: 87, bestChain: 1051 },
    update: {},
  });

  await db.factionMembership.create({
    data: { userId: user.id, factionId: faction.id, joinedAt: new Date((start - 300 * DAY) * 1000), isActive: true, sourceRef: "demo" },
  });

  await ensureSyncStates(db, user.id);
  // History-walk resources get internally consistent fabricated coverage:
  // their backward walks count as finished (source exhausted), which the
  // data-confidence derivation reads as a complete synthetic dataset.
  // (Routine top-ups refresh these timestamps via refreshDemoSyncHealth.)
  const walkResources = new Set(["drugs", "rehab", "money_logs", "travel", "events", "attacks"]);
  for (const state of await db.syncState.findMany({ where: { userId: user.id } })) {
    await db.syncState.update({
      where: { id: state.id },
      data: {
        status: "idle",
        lastSuccessAt: new Date(now * 1000),
        lastAttemptAt: new Date(now * 1000),
        lastCompletedAt: new Date(now * 1000),
        recordsCollected: 2500,
        ...(walkResources.has(state.resource) ? { stopReason: "source_exhausted" as const, lastTimestamp: BigInt(now) } : {}),
        nextRunAt: new Date((now + state.frequencySeconds) * 1000),
      },
    });
  }

  /* ----------------------------- catalog prices -------------------------- */
  // ISOLATION: TornItemCatalog is a GLOBAL table shared by every profile, so
  // the demo seed must NEVER write to it — its synthetic prices (e.g. Xanax
  // at $45k) would overwrite real Torn market prices for production
  // analytics. Demo reads whatever the real catalog holds; the demo's own
  // consumption rows carry explicit per-row values below.
  const demoItemIds = [...DRUGS.map((d) => d.itemId), ...PLUSHIES.map((p) => p.itemId), ...FLOWERS.map((f) => f.itemId)];
  const catalogRows = await db.tornItemCatalog.findMany({ where: { itemId: { in: demoItemIds } }, select: { itemId: true, marketPrice: true } });
  const realPrices = new Map<number, bigint>(catalogRows.filter((r) => r.marketPrice !== null).map((r) => [r.itemId, r.marketPrice as bigint]));
  const xanaxItem = DRUGS.find((d) => d.name === "Xanax")!;
  const xanaxPrice = realPrices.get(xanaxItem.itemId) ?? BigInt(xanaxItem.price);

  /* ------------------- ranked wars + personal payouts -------------------- */
  // Seeded BEFORE the history generator so the payouts are part of the
  // wallet-tracked ledger (a recorded payout that never reached the tracked
  // wallet would fabricate a phantom reconciliation residual).
  const warRows = [
    { id: 9001, opponent: "DEMO Rivals", started: now - 90 * DAY, days: 5, win: true, our: 12_000, their: 8_500, payout: 8_000_000 },
    { id: 9002, opponent: "DEMO Warriors", started: now - 60 * DAY, days: 4, win: true, our: 15_200, their: 9_100, payout: 12_500_000 },
    { id: 9003, opponent: "DEMO Titans", started: now - 30 * DAY, days: 6, win: false, our: 7_400, their: 16_800, payout: 2_000_000 },
    { id: 9004, opponent: "DEMO Wolves", started: now - 10 * DAY, days: 5, win: true, our: 18_300, their: 11_000, payout: 15_000_000 },
  ];
  const payoutRows: DemoMoneyRow[] = [];
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
    // Personal payout inside the settlement tail (time-window match) —
    // wallet cash, tracked by the snapshots (no scenario metadata).
    payoutRows.push({
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
    });
  }

  /* -------------------- signature day (yesterday, UTC) ------------------- */
  // A deterministic, coherent "yesterday" so the Daily Summary always has a
  // day worth explaining: earned income, a bazaar sale (conversion), a stock
  // buy, an internal bank movement with yield, a true gym expense, a rehab
  // visit, a renter-side rental extension and an OC payout credited to the
  // FACTION BALANCE (exercises the wallet-flow exclusion). Fixed hours keep
  // it reproducible; routine top-ups NEVER recreate or delete it.
  // (Its MONEY rows are passed to the generator as preset rows so the
  // networth snapshots track them like real data would.)
  const sigStart = Math.floor(now / DAY) * DAY - DAY; // UTC midnight, yesterday
  const sig = (h: number, m = 0): Date => new Date((sigStart + h * 3600 + m * 60) * 1000);
  const sigMoneyRows: DemoMoneyRow[] = [
    { userId: user.id, occurredAt: sig(2, 15), category: "salary", direction: "income", amount: 365_000n, source: "demo", sourceRef: "demo:sig:salary", description: "Salary money receive" },
    // Bazaar sale: big cash inflow, but an asset conversion — never profit.
    { userId: user.id, occurredAt: sig(9, 40), category: "bazaar", direction: "income", amount: 2_400_000n, source: "demo", sourceRef: "demo:sig:bazaarsale", description: "Bazaar sale money receive" },
    // Stock purchase: cash → asset (conversion, not an expense).
    { userId: user.id, occurredAt: sig(11, 5), category: "stock", direction: "expense", amount: -1_500_000n, source: "demo", sourceRef: "demo:sig:stockbuy", description: "Stock buy money sent" },
    // Bank invest then withdraw WITH yield: deposit leaves the wallet
    // (neutral); the interest must surface only as derived economic income.
    { userId: user.id, occurredAt: sig(11, 20), category: "city_bank", direction: "neutral", amount: -500_000n, source: "demo", sourceRef: "demo:sig:bankdep", description: "Bank invest" },
    { userId: user.id, occurredAt: sig(21, 45), category: "city_bank", direction: "neutral", amount: 521_000n, source: "demo", sourceRef: "demo:sig:bankwd", description: "Bank withdraw" },
    { userId: user.id, occurredAt: sig(18, 30), category: "gym", direction: "expense", amount: -75_000n, source: "demo", sourceRef: "demo:sig:gym", description: "Gym paid" },
    { userId: user.id, occurredAt: sig(14, 10), category: "rehab", direction: "expense", amount: -250_000n, source: "demo", sourceRef: "demo:sig:rehab", description: "Drug rehabilitation paid" },
    { userId: user.id, occurredAt: sig(16, 5), category: "housing", direction: "expense", amount: -3_200_000n, source: "demo", sourceRef: "demo:sig:rent", description: "Property rental market extension accept renter", subcategory: "Property rental market extension accept renter" },
    // OC payout: earned income credited to the FACTION MEMBER BALANCE —
    // excluded from wallet flows (scenario metadata), so the bridge never
    // reports a phantom gap.
    { userId: user.id, occurredAt: sig(15, 0), category: "faction", direction: "income", amount: 1_200_000n, source: "demo", sourceRef: "demo:sig:ocpayout", description: "Faction payout money balance receive", subcategory: "Faction payout money balance receive", metadata: { demo: true, data: { scenario: "Break the Bank" } } },
    /* -------------------- insight window (2.0) ---------------------------- */
    // Two deterministic days that let the insights engine show its curated
    // rules without inventing anything: a clear casino windfall three days
    // ago (true income — fires "best income day" and lifts the 7-day income
    // vs the 30-day baseline) and a rehab spike two days ago (true expense
    // — fires "rehab spend at a high"). Same preset-rows mechanism as the
    // signature day, so the networth walk stays coherent.
    { userId: user.id, occurredAt: new Date((sigStart - 2 * DAY + 20 * 3600 + 15 * 60) * 1000), category: "casino", direction: "income", amount: 6_000_000n, source: "demo", sourceRef: "demo:sig:casinowindfall", description: "Casino money receive" },
    { userId: user.id, occurredAt: new Date((sigStart - DAY + 9 * 3600 + 30 * 60) * 1000), category: "rehab", direction: "expense", amount: -4_000_000n, source: "demo", sourceRef: "demo:sig:rehabspike1", description: "Drug rehabilitation paid" },
    { userId: user.id, occurredAt: new Date((sigStart - DAY + 19 * 3600 + 45 * 60) * 1000), category: "rehab", direction: "expense", amount: -4_000_000n, source: "demo", sourceRef: "demo:sig:rehabspike2", description: "Drug rehabilitation paid" },
  ];

  /* -------------------- shared history generation ------------------------ */
  // ONE generator for the full 180-day history and the routine top-up —
  // deterministic per UTC day bucket, so this run and every future top-up
  // produce coherent, non-overlapping synthetic history.
  const generation = await generateDemoHistory(db, {
    userId: user.id,
    fromSec: start,
    toSec: now,
    gridOffset: now % 3600,
    xanaxUnitPrice: xanaxPrice,
    // The full seed only simulated the last 10 days of bars / 30 days of
    // hourly stat snapshots — same windows as the original seed.
    barsFromSec: now - 10 * DAY,
    statsFromSec: now - 30 * DAY,
    presetMoneyRows: [...sigMoneyRows, ...payoutRows],
    // Random personal Xanax would consume the armory sponsorship pool FIFO
    // before the signature day's own sponsored uses — reserve the window.
    reserveXanaxDays: [Math.floor(sigStart / DAY)],
    jumpAnchorDay: Math.floor(sigStart / DAY) - 1,
    state: {
      userId: user.id,
      nwBase: 180_000_000,
      nwCapturedSec: start - HOUR,
      wallet: 25_000_000,
      stats: { str: 12_400_000, def: 9_850_000, spd: 10_320_000, dex: 8_640_000 },
      cum: { xanax: 347, ecstasy: 41, refills: 137, candy: 2673 - 40, awards: 172, overdoses: 11 },
      energy: 40,
      happy: 1200,
      travelCursor: start,
      fromSec: start,
    },
  });

  /* ------------------------- signature-day extras ------------------------ */
  // Two Xanax uses; the first is faction-sponsored (armory "used" evidence),
  // the second draws the armory batch — both land in confirmed_faction with
  // a personal cost of exactly $0.
  await db.drugEvent.createMany({
    data: [
      { userId: user.id, occurredAt: sig(10, 0), drugItemId: xanaxItem.itemId, drugName: "Xanax", outcome: "success", source: "demo", sourceRef: "demo:sig:xanax1" },
      { userId: user.id, occurredAt: sig(22, 30), drugItemId: xanaxItem.itemId, drugName: "Xanax", outcome: "success", source: "demo", sourceRef: "demo:sig:xanax2" },
    ],
    skipDuplicates: true,
  });
  await db.consumptionEvent.createMany({
    data: [
      { userId: user.id, occurredAt: sig(10, 0), itemId: xanaxItem.itemId, itemName: "Xanax", category: "drug", quantity: 1, unitValue: xanaxPrice, totalValue: xanaxPrice, valuationMethod: "catalog_market_price", provenance: "estimated", source: "derived_drug_event", sourceRef: "demo:sig:xanax1" },
      { userId: user.id, occurredAt: sig(22, 30), itemId: xanaxItem.itemId, itemName: "Xanax", category: "drug", quantity: 1, unitValue: xanaxPrice, totalValue: xanaxPrice, valuationMethod: "catalog_market_price", provenance: "estimated", source: "derived_drug_event", sourceRef: "demo:sig:xanax2" },
    ],
    skipDuplicates: true,
  });
  await db.factionArmoryEvent.createMany({
    data: [
      { userId: user.id, factionId: DEMO_FACTION_ID, memberId: DEMO_TORN_ID, memberName: "DEMO_Player", itemId: xanaxItem.itemId, itemName: "Xanax", action: "used", quantity: 1, value: xanaxPrice, source: "demo", sourceRef: "demo:sig:armory-used", occurredAt: sig(10, 0) },
      // Lent 06:00 ON the signature morning, qty 3: the FIFO sponsorship
      // pool for the day's two uses is deterministically the armory stock —
      // earlier personal history can never consume it.
      { userId: user.id, factionId: DEMO_FACTION_ID, memberId: DEMO_TORN_ID, memberName: "DEMO_Player", itemId: xanaxItem.itemId, itemName: "Xanax", action: "lent", quantity: 3, value: xanaxPrice * 3n, source: "demo", sourceRef: "demo:sig:armory-lent", occurredAt: sig(6) },
    ],
    skipDuplicates: true,
  });

  await db.rehabEvent.create({
    data: { userId: user.id, occurredAt: sig(14, 10), rehabPercent: 60, cost: 250_000n, sessions: 2, addictionPointsRemoved: 95, source: "demo", sourceRef: "demo:sig:rehab" },
  });

  // Insight-window rehab spike: two visits the day before the signature day,
  // mirroring the injected rehab money rows (same instants, same costs).
  await db.rehabEvent.createMany({
    data: [
      { userId: user.id, occurredAt: new Date((sigStart - DAY + 9 * 3600 + 30 * 60) * 1000), rehabPercent: 25, cost: 4_000_000n, sessions: 3, addictionPointsRemoved: 120, source: "demo", sourceRef: "demo:sig:rehabspike1" },
      { userId: user.id, occurredAt: new Date((sigStart - DAY + 19 * 3600 + 45 * 60) * 1000), rehabPercent: 18, cost: 4_000_000n, sessions: 2, addictionPointsRemoved: 90, source: "demo", sourceRef: "demo:sig:rehabspike2" },
    ],
    skipDuplicates: true,
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

  /* --------------------- faction chains / OCs / balance ------------------ */
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

  /* --------------------- synthetic notification history ------------------ */
  // Demo-visible delivery ledger: exercises sent / deferred / suppressed /
  // expired / test rows in Settings. The notification worker NEVER evaluates
  // demo profiles, so these rows can never produce a real Web Push. Routine
  // top-ups do NOT touch notifications at all.
  const notifDefaults = { energy_full: false, travel_arrival: true, drug_cooldown: true, trades: true, mail: true, goal_achieved: true, goal_milestone: true, oc_ready_soon: true, significant_insight: false };
  await db.notificationPreference.create({
    data: {
      userId: user.id,
      categories: notifDefaults,
      quietStartMin: 22 * 60 + 30,
      quietEndMin: 7 * 60 + 30,
      bypassCritical: true,
      typeConfig: { nearFullThreshold: 135 },
      enabledAt: new Date((now - 30 * DAY) * 1000),
    },
  });

  const demoDevices: Array<{ id: string }> = [];
  for (const [i, ua] of ["iPhone · Safari (demo)", "Desktop · Chrome (demo)"].entries()) {
    const device = await db.pushSubscription.create({
      data: {
        userId: user.id,
        endpoint: `https://demo.push.example/tornscope-demo-${i}-${now}`,
        p256dh: "demo-p256dh-not-a-real-key",
        auth: "demo-auth-not-a-real-key",
        userAgent: ua,
        createdAt: new Date((now - 20 * DAY) * 1000),
        lastSeenAt: new Date((now - 3600) * 1000),
      },
    });
    demoDevices.push(device);
  }

  const demoEvents: Array<{
    type: string; dedupeKey: string; ageSec: number; title: string; body: string;
    status: string; reason?: string; clickPath?: string; provenance?: string;
    sentTo?: number;
  }> = [
    { type: "energy_full", dedupeKey: `energy:full:${now - 3 * 3600}`, ageSec: 3 * 3600, title: "Energy full", body: "Your energy bar is full.", status: "delivered", clickPath: "/today", sentTo: 2 },
    { type: "travel_arrival", dedupeKey: `travelLandsAt:ended:${now - 26 * 3600}`, ageSec: 26 * 3600, title: "Travel landed", body: "Travel landed — welcome home.", status: "delivered", clickPath: "/travel", sentTo: 2 },
    { type: "daily_summary_ready", dedupeKey: `daily-summary:${new Date((now - DAY) * 1000).toISOString().slice(0, 10)}`, ageSec: DAY + 3600, title: "Daily summary ready", body: "Your TornScope daily summary is prepared.", status: "delivered", provenance: "derived", sentTo: 2 },
    { type: "energy_full", dedupeKey: `energy:full:${now - 9 * 3600}`, ageSec: 9 * 3600, title: "Energy full", body: "Your energy bar is full.", status: "expired", reason: "expired", clickPath: "/today" },
    { type: "major_cash_movement", dedupeKey: "cash:money_logs:demo-large-out", ageSec: 7 * 3600, title: "Large outgoing payment", body: "A payment of $82.4m was recorded (faction).", status: "suppressed", reason: "quiet_hours", clickPath: "/money" },
    { type: "capability_lost", dedupeKey: `capability:lost:money_logs:${now - 5 * DAY}`, ageSec: 5 * DAY, title: "Torn access was removed", body: "Wallet history stopped syncing. Your existing history is retained; new data is no longer collected.", status: "delivered", clickPath: "/settings", sentTo: 1 },
    { type: "goal_achieved", dedupeKey: "goal:achieved:demo-networth-80", ageSec: 6 * DAY, title: "Goal reached: Net worth", body: "Your Net worth goal has been reached. Mark it done or raise the bar.", status: "delivered", provenance: "derived", clickPath: "/goals", sentTo: 2 },
    { type: "goal_milestone", dedupeKey: "goal:milestone:demo-networth-125:50", ageSec: 2 * 3600, title: "Goal 50%: Net worth", body: "You are 50% of the way to your Net worth goal.", status: "delivered", provenance: "derived", clickPath: "/goals", sentTo: 2 },
    { type: "test", dedupeKey: `test:${now - 2 * DAY}`, ageSec: 2 * DAY, title: "TornScope test", body: "Push notifications are working on this device.", status: "delivered", sentTo: 1 },
  ];

  for (const e of demoEvents) {
    const occurredAt = new Date((now - e.ageSec) * 1000);
    const event = await db.notificationEvent.create({
      data: {
        userId: user.id,
        type: e.type,
        dedupeKey: e.dedupeKey,
        occurredAt,
        title: e.title,
        body: e.body,
        clickPath: e.clickPath ?? "/today",
        provenance: e.provenance ?? "exact",
        status: e.status,
        reason: e.reason ?? null,
      },
    });
    const targets = e.sentTo ?? 0;
    for (let i = 0; i < targets; i++) {
      await db.notificationDelivery.create({
        data: {
          userId: user.id,
          subscriptionId: demoDevices[i % demoDevices.length]!.id,
          eventKey: e.dedupeKey,
          notificationType: e.type,
          eventId: event.id,
          status: e.status === "delivered" ? "sent" : e.status,
          reason: e.reason ?? null,
          sentAt: occurredAt,
        },
      });
    }
  }

  /* ------------------------------ demo goals (2.0) ----------------------- */
  // Anchored to the generated history so progress/projections are meaningful:
  // one achieved, one mid-flight with a milestone, one long-horizon stat goal.
  const latestNw = await db.networthSnapshot.findFirst({
    where: { userId: user.id },
    orderBy: { capturedAt: "desc" },
    select: { total: true },
  });
  const nwTotal = latestNw ? Number(latestNw.total) : 0;
  const latestStats = await db.personalStatSnapshot.findFirst({
    where: { userId: user.id },
    orderBy: { capturedAt: "desc" },
    select: { stats: true },
  });
  const statTotal = (() => {
    const stats = (latestStats?.stats ?? {}) as { battle_stats?: { strength?: number; defense?: number; speed?: number; dexterity?: number } };
    const bs = stats.battle_stats ?? {};
    const values = [bs.strength, bs.defense, bs.speed, bs.dexterity].filter((v): v is number => typeof v === "number");
    return values.length === 4 ? values.reduce((a, b) => a + b, 0) : null;
  })();

  const demoGoals: Array<{ metric: string; target: bigint; note?: string; status: string; achievedAt?: Date }> = [
    { metric: "networth", target: BigInt(Math.max(1, Math.round(nwTotal * 0.8))), note: "Reached on the way up", status: "achieved", achievedAt: new Date((now - 6 * DAY) * 1000) },
    { metric: "networth", target: BigInt(Math.round(nwTotal * 1.25)), note: "Next quarter-billion milestone", status: "active" },
  ];
  if (statTotal !== null) {
    demoGoals.push({ metric: "battlestats_total", target: BigInt(Math.round(statTotal * 1.5)), note: "Long-run gym target", status: "active" });
  }
  for (const goal of demoGoals) {
    await db.goal.create({ data: { userId: user.id, metric: goal.metric, target: goal.target, note: goal.note ?? null, status: goal.status, achievedAt: goal.achievedAt ?? null } });
  }

  // The watermark starts AT the seed: the first routine top-up is due after
  // the throttle window, not immediately regenerating the seed tail.
  await db.appSetting.upsert({
    where: { userId_key: { userId: user.id, key: DEMO_TOPUP_WATERMARK_KEY } },
    create: { userId: user.id, key: DEMO_TOPUP_WATERMARK_KEY, value: now },
    update: { value: now },
  });

  const counts = { ...generation.counts, rankedWars: warRows.length, chains: chainRows.length, ocs: ocNames.length, notifications: demoEvents.length };
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
