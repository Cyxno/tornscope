import { describe, expect, it } from "vitest";
import { classifyXanaxFunding, type XanaxAcquisition } from "../src/xanax.js";

/**
 * Xanax funding ledger contract (provenance-aware):
 * - uses draw from a STOCK pool, never from "a purchase inside the window";
 * - opening inventory (stock before the range) feeds in-range uses and its
 *   origin is only "personal" when records prove it;
 * - faction sponsorship requires positive armory evidence tied to time;
 * - classification is range-INDEPENDENT: the same unit bought 35 days ago
 *   and used 20 days ago stays attributed in a 30-day view.
 */
const DAY = 86_400;

function purchase(occurredAt: number, units = 1): XanaxAcquisition {
  return { occurredAt, units, source: "personal_purchase" };
}

describe("classifyXanaxFunding", () => {
  const range = { rangeFrom: 30 * DAY };

  it("puts untraceable uses in unknown when no ledger evidence exists at all", () => {
    const r = classifyXanaxFunding({ ...range, uses: [{ occurredAt: 31 * DAY }, { occurredAt: 32 * DAY }], acquisitions: [], preRangeUses: [], armoryUseTimes: [] });
    expect(r).toMatchObject({ confirmedPersonal: 0, confirmedFaction: 0, confirmedOther: 0, openingInventoryUnknown: 0, unknown: 2, hasPreRangeEvidence: false });
  });

  it("matches sponsored armory evidence by near-simultaneous timestamp", () => {
    // Armory news and the personal use log share the exact second (verified live).
    const r = classifyXanaxFunding({
      ...range,
      uses: [{ occurredAt: 31 * DAY + 3600 }, { occurredAt: 31 * DAY + 7200 }],
      acquisitions: [],
      preRangeUses: [],
      armoryUseTimes: [31 * DAY + 3600],
    });
    expect(r.confirmedFaction).toBe(1);
    expect(r.confirmedPersonal).toBe(0);
  });

  it("a purchase before the range feeds in-range uses (opening stock, proven personal)", () => {
    // Bought 35 days ago, consumed 20 days ago: a 30D view must still
    // attribute the use to the recorded purchase (range-independent).
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 50 * DAY }],
      acquisitions: [purchase(15 * DAY, 1)],
      preRangeUses: [],
      armoryUseTimes: [],
    });
    expect(r.confirmedPersonal).toBe(1);
    expect(r.openingInventoryUnknown).toBe(0);
    expect(r.unknown).toBe(0);
  });

  it("opening inventory is NOT treated as an in-range purchase requirement", () => {
    // The real case: player began the window with stock, consumed without
    // buying. Pre-range uses prove possession; uses must not sit in "unknown
    // funding" just because no purchase happened inside the window.
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 31 * DAY }, { occurredAt: 32 * DAY }, { occurredAt: 33 * DAY }],
      acquisitions: [purchase(10 * DAY, 4)],
      preRangeUses: [{ occurredAt: 11 * DAY }],
      armoryUseTimes: [],
    });
    expect(r.confirmedPersonal).toBe(3); // drawn from the recorded purchase stock
    expect(r.openingInventoryUnknown).toBe(0);
    expect(r.unknown).toBe(0);
    expect(r.openingStock.knownUnits).toBe(3);
  });

  it("deficit stock (uses beyond recorded acquisitions) is opening inventory with UNKNOWN origin — never personal", () => {
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 31 * DAY }, { occurredAt: 32 * DAY }],
      acquisitions: [purchase(10 * DAY, 1)],
      preRangeUses: [{ occurredAt: 12 * DAY }, { occurredAt: 13 * DAY }, { occurredAt: 14 * DAY }],
      armoryUseTimes: [],
    });
    // 1 recorded unit was consumed pre-range (use at 12d); uses at 13-14d prove
    // 2 units of unrecorded stock; in-range uses draw from that deficit.
    expect(r.confirmedPersonal).toBe(0);
    expect(r.openingInventoryUnknown).toBe(2);
    expect(r.openingStock.unrecorded).toBe(2);
    expect(r.hasPreRangeEvidence).toBe(true);
  });

  it("without pre-range evidence a use with no pool stays unknown (not opening inventory)", () => {
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 31 * DAY }],
      acquisitions: [],
      preRangeUses: [],
      armoryUseTimes: [],
    });
    expect(r.unknown).toBe(1);
    expect(r.openingInventoryUnknown).toBe(0);
  });

  it("gifts fund confirmed_other (explicit external evidence), never personal", () => {
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 31 * DAY }, { occurredAt: 32 * DAY }],
      acquisitions: [{ occurredAt: 31 * DAY - 600, units: 2, source: "gift" }],
      preRangeUses: [],
      armoryUseTimes: [],
    });
    expect(r.confirmedOther).toBe(2);
    expect(r.confirmedPersonal).toBe(0);
  });

  it("sponsorship wins over pool stock, and pool draws respect FIFO order", () => {
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 31 * DAY }, { occurredAt: 31 * DAY + 60 }, { occurredAt: 31 * DAY + 120 }],
      acquisitions: [purchase(29 * DAY, 3)],
      preRangeUses: [],
      armoryUseTimes: [31 * DAY],
    });
    expect(r.confirmedFaction).toBe(1);
    expect(r.confirmedPersonal).toBe(2);
  });

  it("a use never consumes stock acquired after it (future purchase)", () => {
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 31 * DAY }],
      acquisitions: [purchase(32 * DAY, 5)],
      preRangeUses: [],
      armoryUseTimes: [],
    });
    // The 32d purchase cannot feed a 31d use — and with no other evidence
    // the use stays unknown.
    expect(r.confirmedPersonal).toBe(0);
    expect(r.unknown).toBe(1);
  });

  it("classification does not change when the UI range changes (range-independence)", () => {
    const acquisitions = [purchase(5 * DAY, 10)];
    const preRangeUses = Array.from({ length: 4 }, (_, i) => ({ occurredAt: (10 + i) * DAY }));
    const uses = [{ occurredAt: 40 * DAY }, { occurredAt: 50 * DAY }];
    const in30 = classifyXanaxFunding({ rangeFrom: 30 * DAY, uses, acquisitions, preRangeUses, armoryUseTimes: [] });
    const in90 = classifyXanaxFunding({ rangeFrom: 0, uses, acquisitions, preRangeUses: [], armoryUseTimes: [] });
    // Same units, same evidence → same attribution, different window framing.
    expect(in30.confirmedPersonal).toBe(in90.confirmedPersonal);
    expect(in30.confirmedPersonal).toBe(2);
  });

  it("armory withdrawals (lent/gave) count as faction-sourced stock", () => {
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [{ occurredAt: 31 * DAY }],
      acquisitions: [{ occurredAt: 29 * DAY, units: 2, source: "faction_armory" }],
      preRangeUses: [],
      armoryUseTimes: [],
    });
    expect(r.confirmedFaction).toBe(1);
    expect(r.openingStock.fromFaction).toBe(2); // 2 units held at range start; 1 consumed in-range
  });

  it("opening stock composition splits proven vs unproven origin", () => {
    const r = classifyXanaxFunding({
      rangeFrom: 30 * DAY,
      uses: [],
      acquisitions: [purchase(20 * DAY, 5)],
      preRangeUses: [{ occurredAt: 21 * DAY }, { occurredAt: 22 * DAY }],
      armoryUseTimes: [],
    });
    expect(r.openingStock).toEqual({ knownUnits: 3, fromRecordedPurchases: 3, fromFaction: 0, fromOther: 0, unrecorded: 0 });
  });
});
