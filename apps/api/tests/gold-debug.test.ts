import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getEconomySummary } from "../src/services/economy.js";
import { getDailySummary } from "../src/services/dailySummary.js";

const db = getPrismaClient();
const uid = `dbg2-${randomBytes(8).toString("hex")}`;
const DAY = 86_400;
const nowSec = Math.floor(Date.now() / 1000);
const FULL_CAPS = {
  canReadUserBasic: true, canReadUserBars: true, canReadUserCooldowns: true, canReadUserEducation: true,
  canReadUserTravel: true, canReadUserMoney: true, canReadUserLogs: true, canReadUserAttacks: true,
  canReadUserNetworth: true, canReadUserEvents: true, canReadUserPersonalStats: true,
  canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
  canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
  canReadFactionBalance: false, canReadFactionLogs: false,
};

it("debug economy + daily", async () => {
  await db.user.create({ data: { id: uid, displayName: "dbg2", role: "user", timezone: "UTC" } });
  await db.apiCredential.create({ data: { id: `c-${uid}`, userId: uid, encryptedKey: "x", iv: "x", authTag: "x", keyPreview: "…", logAccessAvailable: true, accessLevel: 3, accessType: "Full", capabilities: FULL_CAPS, validatedAt: new Date() } });
  for (const resource of ["money_logs", "drugs", "travel", "rehab", "events", "networth", "personal_stats", "bars", "attacks"]) {
    await db.syncState.create({ data: { userId: uid, resource, status: "idle", lastSuccessAt: new Date((nowSec - 300) * 1000), recordsCollected: 1000, stopReason: "history_boundary_reached", sourceEarliestAt: BigInt(nowSec - 90 * DAY), lastTimestamp: BigInt(nowSec - 300), frequencySeconds: 600, nextRunAt: new Date((nowSec + 600) * 1000) } });
  }
  const from = nowSec - 3600;
  await db.moneyEvent.createMany({
    data: [
      { userId: uid, occurredAt: new Date((from + 360) * 1000), category: "salary", direction: "income", amount: 5_000n, source: "test", sourceRef: `s1-${uid}` },
      { userId: uid, occurredAt: new Date((from + 720) * 1000), category: "bazaar", direction: "income", amount: 6_000n, source: "test", sourceRef: `s2-${uid}` },
      { userId: uid, occurredAt: new Date((from + 1080) * 1000), category: "rehab", direction: "expense", amount: -1_000n, source: "test", sourceRef: `s3-${uid}` },
      { userId: uid, occurredAt: new Date((from + 1440) * 1000), category: "museum", direction: "unknown", amount: 777n, source: "test", sourceRef: `s4-${uid}` },
    ],
    skipDuplicates: true,
  });
  const eco = await getEconomySummary(uid, { preset: "custom", from, to: from + 3600 });
  console.log("ECO cashFlow:", JSON.stringify(eco.cashFlow));
  const dayStart = Math.floor(nowSec / DAY) * DAY - DAY;
  await db.moneyEvent.createMany({
    data: [
      { userId: uid, occurredAt: new Date((dayStart + 9 * 3600) * 1000), category: "salary", direction: "income", amount: 5_000n, source: "test", sourceRef: `d1-${uid}` },
      { userId: uid, occurredAt: new Date((dayStart + 15 * 3600) * 1000), category: "rehab", direction: "expense", amount: -1_000n, source: "test", sourceRef: `d2-${uid}` },
    ],
    skipDuplicates: true,
  });
  const daily = await getDailySummary({ id: uid, timezone: "UTC", isDemo: false }, undefined as never);
  console.log("DAILY received:", JSON.stringify(daily.cashFlow.received), "range:", JSON.stringify(daily.range));
  // drug consumed debug
  await db.drugEvent.createMany({ data: [1, 2].map((i) => ({ userId: uid, occurredAt: new Date((nowSec - 7200 + i * 60) * 1000), drugName: "Xanax", drugItemId: 206, outcome: "success" as const, source: "test", sourceRef: `dx${i}-${uid}` })), skipDuplicates: true });
  const daily2 = await getDailySummary({ id: uid, timezone: "UTC", isDemo: false }, undefined as never);
  console.log("DAILY drugs:", JSON.stringify(daily2.drugs));
  expect(true).toBe(true);
});
