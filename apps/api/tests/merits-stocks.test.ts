import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { getPrismaClient } from "@tornscope/database";
import { getMerits } from "../src/services/merits.js";
import { getStocks } from "../src/services/stocks.js";
import { loadAvailabilityContext } from "../src/services/availability.js";
import { liveAvailability } from "../src/services/availability.js";
import { LIMITED_PRESET } from "@tornscope/shared";

/**
 * Merits & Stocks capability + demo coherence tests (v0.2 feature
 * completion, Phases 49/57).
 *
 * - Demo datasets must be mathematically coherent AND exercise every
 *   reward class / holding state through the real assembly code.
 * - A limited key (no merits/stocks selections cannot happen — they are
 *   level-1 selections — but the gate must still degrade gracefully for
 *   missing capabilities / missing keys) renders honest availability
 *   states, never zeros.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();
const cleanupIds: string[] = [];

afterAll(async () => {
  for (const id of cleanupIds) {
    await db.user.deleteMany({ where: { id } });
  }
});

describe("demo datasets (Phase 49)", () => {
  it("demo merits mix maxed, partial, cap-unknown and untouched states", async () => {
    const res = await getMerits({ id: "demo", isDemo: true });
    expect(res.availability.state).toBe("available_historical");
    expect(res.summary.maxedCount).toBeGreaterThan(0);
    expect(res.summary.partialCount).toBeGreaterThan(0);
    expect(res.summary.untouchedCount).toBeGreaterThan(0);
    expect(res.summary.capUnknownCount).toBeGreaterThan(0);
    expect(res.summary.available).not.toBeNull();
    // Coherence: owned count equals owned rows; used equals summed ranks.
    const ownedRows = res.merits.filter((m) => m.owned).length;
    expect(res.summary.ownedCount).toBe(ownedRows);
    expect(res.summary.used).toBe(res.merits.reduce((sum, m) => sum + (m.level ?? 0), 0));
    // Every maxed row has a maintained cap; no cap-unknown row claims maxed.
    for (const row of res.merits) {
      if (row.state === "maxed") expect(row.maxLevel).not.toBeNull();
      if (row.maxLevel === null) expect(row.state).not.toBe("maxed");
    }
  });

  it("demo stocks cover cash, item, passive, points and unvalued rewards", async () => {
    const res = await getStocks({ id: "demo", isDemo: true });
    const owned = res.rows.filter((r) => r.owned);
    expect(owned.length).toBe(res.summary.stocksOwned);
    expect(res.summary.activeBenefits).toBe(3);

    const kinds = new Set(res.rows.map((r) => r.reward?.kind));
    expect(kinds.has("fixed_cash")).toBe(true);
    expect(kinds.has("item")).toBe(true);
    expect(kinds.has("non_monetary")).toBe(true);
    expect(kinds.has("points")).toBe(true);
    expect(kinds.has("unvalued")).toBe(true);

    // The unvalued active benefit is disclosed, never rendered as $0.
    expect(res.summary.unvaluedBenefitCount).toBeGreaterThan(0);
    for (const row of res.rows) {
      if (row.reward?.valuePerPayout === null) {
        expect(row.estimatedAnnualValue).toBeNull();
        expect(row.estimatedYieldPct).toBeNull();
        expect(row.estimatedPaybackDays).toBeNull();
      }
    }
    // Derived timing exists and is never negative.
    const timed = res.rows.filter((r) => r.timing?.kind === "derived");
    expect(timed.length).toBeGreaterThan(0);
    for (const row of timed) expect(row.timing?.daysRemaining ?? 0).toBeGreaterThanOrEqual(0);
    // A ready benefit exists.
    expect(res.rows.some((r) => r.timing?.kind === "ready")).toBe(true);
  });
});

suite("capability gating (Phase 57)", () => {
  let limitedUserId: string;

  beforeAll(async () => {
    limitedUserId = `mstest-${randomBytes(8).toString("hex")}`;
    cleanupIds.push(limitedUserId);
    await db.user.create({
      data: { id: limitedUserId, displayName: "merits-stocks-gate", role: "user", timezone: "UTC" },
    });
    // A stored credential whose capability blob predates merits/stocks keys
    // (incomplete shape) must fall back to the access level — level 4 keeps
    // merits/stocks readable.
    await db.apiCredential.create({
      data: {
        id: `c-${limitedUserId}`,
        userId: limitedUserId,
        encryptedKey: "x",
        iv: "x",
        authTag: "x",
        keyPreview: "…",
        logAccessAvailable: true,
        accessLevel: 4,
        accessType: "Full",
        capabilities: LIMITED_PRESET,
        validatedAt: new Date(),
      },
    });
  });

  it("a level-4 key without explicit merits/stocks booleans keeps both via fallback", async () => {
    const ctx = await loadAvailabilityContext(limitedUserId);
    // The capability gate opens; a live fetch would then succeed and the
    // response overrides its availability to available_live (pre-fetch the
    // matrix honestly reports no stored data).
    expect(ctx.caps?.canReadUserMerits).toBe(true);
    expect(ctx.caps?.canReadUserStocks).toBe(true);
    expect(liveAvailability(ctx, "merits_overview").state).toBe("unavailable_source");
  });

  it("a keyless profile gets permission-based unavailability, not zeros", async () => {
    const keyless = `mstest2-${randomBytes(8).toString("hex")}`;
    cleanupIds.push(keyless);
    await db.user.create({ data: { id: keyless, displayName: "no-key", role: "user", timezone: "UTC" } });
    const ctx = await loadAvailabilityContext(keyless);
    const meritsAvailability = liveAvailability(ctx, "merits_overview");
    const stocksAvailability = liveAvailability(ctx, "stocks_holdings");
    expect(meritsAvailability.state).toBe("unavailable_permission");
    expect(stocksAvailability.state).toBe("unavailable_permission");
    expect(meritsAvailability.requiresLabel).toBeTruthy();
  });
});
