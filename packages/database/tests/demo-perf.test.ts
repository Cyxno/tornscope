import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient, maybeTopUpDemoData } from "../src/index.js";
import { generateDemoHistory, type DemoContinuationState } from "../src/demo/generator.js";
import { DAY } from "../src/demo/constants.js";
const HOUR = 3600;

const db = getPrismaClient();
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suffix = randomBytes(6).toString("hex");
let userId = "";
const NOW = Math.floor(Date.UTC(2026, 9, 15, 12, 0, 0) / 1000);

function initialState(fromSec: number): DemoContinuationState {
  return { userId, nwBase: 180_000_000, nwCapturedSec: fromSec - HOUR_FALLBACK, wallet: 25_000_000,
    stats: { str: 1, def: 1, spd: 1, dex: 1 }, cum: { xanax: 1, ecstasy: 1, refills: 1, candy: 1, awards: 1, overdoses: 1 },
    energy: 40, happy: 1200, travelCursor: fromSec, fromSec };
}
const HOUR_FALLBACK = 3600;

beforeAll(async () => {
  userId = (await db.user.create({ data: { email: `demo-perf-${suffix}@tornscope.local`, displayName: "perf", role: "user", isDemo: true } })).id;
  // Initial history 34 days stale — the baseline the catch-ups extend.
  await generateDemoHistory(db, {
    userId, fromSec: NOW - 34 * DAY, toSec: NOW - 34 * DAY + HOUR,
    state: initialState(NOW - 34 * DAY), gridOffset: 0, xanaxUnitPrice: 45_000n,
  });
});
afterAll(async () => {
  await db.user.deleteMany({ where: { email: `demo-perf-${suffix}` } }).catch(() => undefined);
  await db.$disconnect();
});

const suite = dbUrl ? describe : describe.skip;
suite("demo top-up performance", () => {
  it("measures no-op, 1-day, 7-day, 30-day catch-ups", async () => {
    const run = async (staleDays: number) => {
      await db.appSetting.upsert({
        where: { userId_key: { userId, key: "demo_topup_watermark_at" } },
        create: { userId, key: "demo_topup_watermark_at", value: NOW - staleDays * DAY },
        update: { value: NOW - staleDays * DAY },
      });
      const t0 = Date.now();
      const r = await maybeTopUpDemoData(NOW, userId);
      return { status: r.status, ms: Date.now() - t0 };
    };
    // Descending staleness so each scenario extends real history.
    const d30 = await run(30);
    console.log("PERF 30-day:", d30);
    const d7 = await run(7);
    console.log("PERF 7-day:", d7);
    const d1 = await run(1);
    console.log("PERF 1-day:", d1);
    const noop = await run(0.001); // within throttle → no-op path
    console.log("PERF no-op(throttled):", noop);
    expect(d30.status).toBe("done");
    expect(noop.status).toBe("current");
  }, 60_000);
});
