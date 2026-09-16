import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { INGEST_MAX_FUTURE_DRIFT_SEC, INGEST_MIN_EPOCH_SEC, isPlausibleIngestedDate, rejectImplausibleRows } from "../src/normalizers/guards.js";

/**
 * 1.0.1 regression coverage for the ingestion timestamp guard: absurd
 * external timestamps (ms-vs-seconds slips, overflow, pre-Torn garbage) are
 * rejected at the persistence boundary instead of being stored as Dates that
 * PostgreSQL/Prisma cannot round-trip.
 */

const NOW = new Date("2026-09-16T12:00:00.000Z");

describe("isPlausibleIngestedDate", () => {
  it("accepts a normal 2026 timestamp", () => {
    expect(isPlausibleIngestedDate(new Date("2026-09-15T10:00:00.000Z"), NOW)).toBe(true);
  });

  it("accepts timestamps within the future-drift window", () => {
    expect(isPlausibleIngestedDate(new Date(NOW.getTime() + INGEST_MAX_FUTURE_DRIFT_SEC * 1000), NOW)).toBe(true);
  });

  it("rejects the 1.0.0 ms-vs-seconds double conversion (year ~58659)", () => {
    // The observed production failure shape: a millisecond Date multiplied by
    // 1000 again -> +058659-08-21T04:09:48.000Z.
    expect(isPlausibleIngestedDate(new Date("+058659-08-21T04:09:48.000Z"), NOW)).toBe(false);
  });

  it("rejects timestamps before Torn existed (2004)", () => {
    expect(isPlausibleIngestedDate(new Date(INGEST_MIN_EPOCH_SEC * 1000 - 1), NOW)).toBe(false);
    expect(isPlausibleIngestedDate(new Date("1999-01-01T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("accepts the exact epoch-second floor", () => {
    expect(isPlausibleIngestedDate(new Date(INGEST_MIN_EPOCH_SEC * 1000), NOW)).toBe(true);
  });

  it("rejects impossible magnitudes and invalid dates", () => {
    expect(isPlausibleIngestedDate(new Date(8.64e15 + 1), NOW)).toBe(false); // beyond JS Date range
    expect(isPlausibleIngestedDate(new Date(Number.NaN), NOW)).toBe(false);
    expect(isPlausibleIngestedDate(new Date(Infinity), NOW)).toBe(false);
  });
});

describe("rejectImplausibleRows", () => {
  it("keeps valid rows and drops absurd ones with their identity reported", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    const rows = [
      { sourceRef: "torn_event:1", occurredAt: new Date("2026-09-16T11:00:00.000Z") },
      { sourceRef: "torn_event:2", occurredAt: new Date("+058659-08-21T04:09:48.000Z") },
      { sourceRef: "torn_event:3", occurredAt: new Date("2015-03-01T00:00:00.000Z") },
    ];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const kept = rejectImplausibleRows(rows, (r) => r.occurredAt, (r) => r.sourceRef, now);
      expect(kept.map((r) => r.sourceRef)).toEqual(["torn_event:1", "torn_event:3"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("torn_event:2"))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* DB-backed: the guard is applied inside the ingest repositories              */
/* -------------------------------------------------------------------------- */

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const dbSuite = dbUrl ? describe : describe.skip;

dbSuite("insert repositories apply the timestamp guard", () => {
  it("insertTimelineEvents persists only plausible rows (1.0.1 regression)", async () => {
    const { getPrismaClient } = await import("../src/index.js");
    const { insertTimelineEvents } = await import("../src/repositories/ingest.js");
    const db = getPrismaClient();
    const userId = `guard-${randomUUID()}`;
    await db.user.create({ data: { id: userId, displayName: "guard-test", timezone: "UTC" } });
    try {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(String(msg));
      let written = 0;
      try {
        written = await insertTimelineEvents(db, userId, [
          {
            occurredAt: new Date(Date.now() - 60_000),
            type: "torn_event",
            category: null,
            title: "You received mail",
            description: "You received mail.",
            amount: null,
            sourceRef: "torn_event:guard-valid",
            raw: undefined,
          },
          {
            // The year-58659 shape: must never reach the database.
            occurredAt: new Date("+058659-08-21T04:09:48.000Z"),
            type: "torn_event",
            category: null,
            title: "impossible",
            description: "impossible",
            amount: null,
            sourceRef: "torn_event:guard-absurd",
            raw: undefined,
          },
        ]);
      } finally {
        console.warn = originalWarn;
      }
      expect(written).toBe(1);
      const rows = await db.timelineEvent.findMany({ where: { userId }, select: { sourceRef: true } });
      expect(rows.map((r) => r.sourceRef)).toEqual(["torn_event:guard-valid"]);
      expect(warnings.some((w) => w.includes("torn_event:guard-absurd"))).toBe(true);
    } finally {
      await db.timelineEvent.deleteMany({ where: { userId } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    }
  });
});
