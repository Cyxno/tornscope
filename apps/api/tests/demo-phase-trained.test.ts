import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient, generateDemoHistory } from "@tornscope/database";
import { getProgression } from "../src/services/progression.js";

/**
 * Demo training inference is seed-phase independent (1.0.1 regression).
 *
 * The demo generator anchors training bursts at gridOffset past the hour
 * and lands each burst's stat gain on the first hourly snapshot at/after
 * the burst end. The snapshot grid used to DOUBLE-COUNT gridOffset
 * (statsFrom already carries the seed moment's sub-hour phase), rotating
 * the snapshot grid away from the burst grid. Whether the analyzer's
 * bracket then closed on a pre-gain snapshot — zeroing gym attribution and
 * summary.energyTrained — became a pure function of the seed wall-clock
 * minute: hosted CI seeded at 19:22 UTC failed energyTrained=0 while a
 * locally seeded database (19:45 UTC) passed the identical tree.
 *
 * This suite replays the seed at several gridOffset phases (0 through the
 * exact CI-failure phase 1320 and the local-pass phase 2702) and asserts
 * the real progression service still attributes training energy.
 */

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const dbSuite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const DAY = 86_400;
const HOUR = 3_600;

dbSuite("demo training inference across seed phases", () => {
  it("energyTrained > 0 whatever minute the demo was seeded at", { timeout: 240_000 }, async () => {
    const phases = [0, 1320, 3540]; // grid edges + the exact CI-failure phase (seed 19:22 UTC)
    const todayUtc = Math.floor(Date.now() / 1000 / DAY) * DAY;
    for (const offset of phases) {
      const T = todayUtc + offset + 20 * HOUR; // a fixed evening seed moment
      const now = T + 10 * 60; // the test runs a few minutes after the seed
      const suffix = randomBytes(4).toString("hex");
      const user = await db.user.create({
        data: { email: `phase-trained-${suffix}@tornscope.local`, displayName: "phase-trained", role: "user", isDemo: true },
      });
      try {
        await generateDemoHistory(db, {
          userId: user.id,
          fromSec: T - 5 * DAY,
          toSec: T,
          gridOffset: offset,
          xanaxUnitPrice: 45_000n,
          barsFromSec: T - 5 * DAY,
          statsFromSec: T - 5 * DAY,
          jumpAnchorDay: Math.floor(T / DAY) - 2, // seed convention: sigDay - 1
          state: {
            userId: user.id,
            nwBase: 180_000_000,
            nwCapturedSec: T - 5 * DAY - HOUR,
            wallet: 25_000_000,
            stats: { str: 12_400_000, def: 9_850_000, spd: 10_320_000, dex: 8_640_000 },
            cum: { xanax: 347, ecstasy: 41, refills: 137, candy: 2633, awards: 172, overdoses: 11 },
            energy: 40,
            happy: 1200,
            travelCursor: T - 5 * DAY,
            fromSec: T - 5 * DAY,
          },
        });

        const s = await getProgression(user.id, { preset: "custom", from: now - 3 * DAY, to: now });
        expect(s.energy.covered, `phase ${offset}: bars not covered`).toBe(true);
        expect(s.summary.energyTrained.value, `phase ${offset}: energyTrained was 0 — brackets broke`).toBeGreaterThan(0);
        const likely = s.training.sessions.filter((x) => x.inference === "likely").length;
        expect(likely, `phase ${offset}: no likely training session`).toBeGreaterThanOrEqual(2);
      } finally {
        await db.drugEvent.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.consumptionEvent.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.timelineEvent.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.barsSnapshot.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.personalStatSnapshot.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.combatEvent.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.moneyEvent.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.networthSnapshot.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.travelEvent.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.crimeEvent.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.userSnapshot.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.tornAccount.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
        await db.user.deleteMany({ where: { id: user.id } }).catch(() => undefined);
      }
    }
  });
});
