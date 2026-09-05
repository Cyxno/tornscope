import { describe, expect, it } from "vitest";
import { countryLabel, countryName, travelTransitionFor, TORN_COUNTRY_NAMES } from "../src/normalizers/titles.js";
import { assembleTripsFromTransitionRows } from "../src/travel/assemble.js";
import type { TornUserLog } from "@tornscope/torn-api";
import { normalizeLogEntry } from "../src/normalizers/logs.js";

/**
 * Country mapping tests against the OFFICIAL Torn API v2 OpenAPI spec's
 * CountryEnum, whose values are declared in country-id order:
 *   Torn(1), Mexico(2), Hawaii(3), South Africa(4), Japan(5), China(6),
 *   Argentina(7), Switzerland(8), Canada(9), United Kingdom(10), UAE(11),
 *   Cayman Islands(12).
 *
 * Cross-checked against live account data: Chamois Plushie (Swiss exclusive)
 * bought in area 8, Wolverine Plushie in area 9 (Canada), Heather in area 10
 * (UK), Camel Plushie + Tribulus Omanense in area 11 (UAE, confirmed by
 * /v2/user/travel's destination name).
 */

const OFFICIAL_MAPPING: Record<number, string> = {
  1: "Torn",
  2: "Mexico",
  3: "Hawaii",
  4: "South Africa",
  5: "Japan",
  6: "China",
  7: "Argentina",
  8: "Switzerland",
  9: "Canada",
  10: "United Kingdom",
  11: "UAE",
  12: "Cayman Islands",
};

describe("official Torn country mapping", () => {
  it("maps every official country id", () => {
    for (const [id, name] of Object.entries(OFFICIAL_MAPPING)) {
      expect(countryName(Number(id)), `country id ${id}`).toBe(name);
    }
  });

  it("exposes exactly the official 12 ids", () => {
    expect(Object.keys(TORN_COUNTRY_NAMES).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("does not silently map unknown ids (countryName)", () => {
    expect(countryName(13)).toBeNull();
    expect(countryName(0)).toBeNull();
    expect(countryName(null)).toBeNull();
    expect(countryName(undefined)).toBeNull();
  });
});

describe("Switzerland vs Mexico regression", () => {
  it("destination id 8 is Switzerland (a real Swiss flight was labeled Mexico)", () => {
    expect(countryLabel(8)).toBe("Switzerland");
    const departure = travelTransitionFor("Travel depart", { origin: 1, duration: 6780, destination: 8, travel_method: "personal" });
    expect(departure?.type).toBe("DEPARTED_TORN");
    expect(departure?.countryId).toBe(8);
    expect(departure?.country).toBe("Switzerland");
  });

  it("destination id 2 is Mexico (no other id may claim it)", () => {
    expect(countryLabel(2)).toBe("Mexico");
    const departure = travelTransitionFor("Travel depart", { origin: 1, destination: 2 });
    expect(departure?.type).toBe("DEPARTED_TORN");
    expect(departure?.country).toBe("Mexico");
  });

  it("a Swiss item purchase (area 8, Chamois Plushie) maps to Switzerland", () => {
    const purchase = travelTransitionFor("Item abroad buy", { area: 8, item: 273, quantity: 28, cost_each: 5000, cost_total: 140000 });
    expect(purchase?.type).toBe("ITEM_PURCHASE");
    expect(purchase?.countryId).toBe(8);
    expect(purchase?.country).toBe("Switzerland");
  });

  it("all remaining destinations resolve per the official enum", () => {
    expect(countryLabel(9)).toBe("Canada");
    expect(countryLabel(10)).toBe("United Kingdom");
    expect(countryLabel(11)).toBe("UAE");
    expect(countryLabel(12)).toBe("Cayman Islands");
    expect(countryLabel(3)).toBe("Hawaii");
    expect(countryLabel(4)).toBe("South Africa");
    expect(countryLabel(5)).toBe("Japan");
    expect(countryLabel(6)).toBe("China");
    expect(countryLabel(7)).toBe("Argentina");
  });
});

describe("unknown destination ids are explicit", () => {
  it("renders Unknown destination ID X for unmapped ids", () => {
    expect(countryLabel(13)).toBe("Unknown destination ID 13");
    expect(countryLabel(0)).toBe("Unknown destination ID 0");
    expect(countryLabel(99)).toBe("Unknown destination ID 99");
  });

  it("null/undefined ids produce no label", () => {
    expect(countryLabel(null)).toBeNull();
    expect(countryLabel(undefined)).toBeNull();
  });

  it("trip assembly keeps the explicit unknown label", () => {
    const { trips } = assembleTripsFromTransitionRows([
      { id: "d1", occurredAt: new Date(1000), type: "DEPARTED_TORN", country: "Unknown destination ID 13", countryId: 13 },
      { id: "a1", occurredAt: new Date(2000), type: "ARRIVED_TORN", country: "Torn", countryId: 1 },
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.destination).toBe("Unknown destination ID 13");
    expect(trips[0]!.destinationCountryId).toBe(13);
  });
});

describe("country names flow through log normalization", () => {
  const ctx = { itemNameById: new Map<number, string>() };

  function normalize(title: string, category: string, data: Record<string, unknown>) {
    return normalizeLogEntry({ id: 1, timestamp: 1_000, details: { id: 1, title, category }, data, params: {} } as unknown as TornUserLog, ctx);
  }

  it("a departure to Switzerland stores countryId 8 and the corrected name", () => {
    const writes = normalize("Travel depart", "Travel", { origin: 1, duration: 6780, destination: 8, travel_method: "personal" });
    expect(writes.travelTransitions).toHaveLength(1);
    expect(writes.travelTransitions[0]!.countryId).toBe(8);
    expect(writes.travelTransitions[0]!.country).toBe("Switzerland");
  });

  it("a departure to Mexico stores countryId 2", () => {
    const writes = normalize("Travel depart", "Travel", { origin: 1, destination: 2 });
    expect(writes.travelTransitions[0]!.countryId).toBe(2);
    expect(writes.travelTransitions[0]!.country).toBe("Mexico");
  });
});
