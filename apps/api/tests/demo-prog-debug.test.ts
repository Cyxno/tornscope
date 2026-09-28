import { describe, expect, it, afterAll } from "vitest";
import { getPrismaClient } from "@tornscope/database";
import { getProgression } from "../src/services/progression.js";

/**
 * Debug/inspection suite for demo progression — requires a real database
 * with the demo seed present, so it gates on TEST_DATABASE_URL exactly like
 * every other DB-backed suite (hermetic local runs skip it instead of red).
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const DAY = 86400;
const nowSec = Math.floor(Date.now() / 1000);

afterAll(async () => {
  if (dbUrl) await db.$disconnect();
});

suite("dbg", () => {
  it("progression on demo", async () => {
    const demoUser = await db.user.findUnique({ where: { email: "demo@tornscope.local" }, select: { id: true } });
    const s = await getProgression(demoUser!.id, { preset: "custom", from: nowSec - 3 * DAY, to: nowSec });
    console.log("covered:", s.energy.covered, "trained:", s.summary.energyTrained.value, "sessions:", s.training.sessions.length, "jumps:", s.happyJumps.jumps.length);
    console.log("bars rows last3d:", await db.barsSnapshot.count({ where: { userId: demoUser!.id, capturedAt: { gte: new Date((nowSec - 3 * DAY) * 1000) } } }));
    console.log("drug rows last3d:", await db.drugEvent.count({ where: { userId: demoUser!.id, occurredAt: { gte: new Date((nowSec - 3 * DAY) * 1000) } } }));
    console.log("combat rows last3d:", await db.combatEvent.count({ where: { userId: demoUser!.id, occurredAt: { gte: new Date((nowSec - 3 * DAY) * 1000) } } }));
    console.log("stat rows last3d:", await db.personalStatSnapshot.count({ where: { userId: demoUser!.id, capturedAt: { gte: new Date((nowSec - 3 * DAY) * 1000) } } }));
    console.log("regenPerHour:", s.energy.regenPerHour);
    console.log("battlestat series:", s.battlestats.series.length, "trackedSince:", s.battlestats.trackedSince);
    for (const sess of s.training.sessions.slice(0, 8)) {
      console.log("SESSION", new Date(sess.startedAt * 1000).toISOString(), "energy:", sess.energySpent, "inference:", sess.inference, "gymGain:", sess.gymGain, "shared:", sess.bracketShared, "evidence:", sess.evidence.join(" | "));
    }
    expect(true).toBe(true);
  });
});
