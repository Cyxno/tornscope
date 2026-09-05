import { describe, expect, it } from "vitest";
import { EncryptionService } from "../src/security/encryption.js";
import { normalizeLogEntry, normalizeTornEvent, type NormalizeContext } from "../src/normalizers/logs.js";
import { pickNumber, sourceRef, stripHtml } from "../src/normalizers/extract.js";
import type { TornUserLog } from "@tornscope/torn-api";

const KEY = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("EncryptionService (AES-256-GCM)", () => {
  it("round-trips a plaintext", () => {
    const svc = new EncryptionService(KEY);
    const enc = svc.encrypt("my-secret-torn-api-key");
    expect(enc.encryptedKey).not.toContain("my-secret");
    expect(svc.decrypt(enc)).toBe("my-secret-torn-api-key");
  });

  it("produces unique IVs per encryption", () => {
    const svc = new EncryptionService(KEY);
    const a = svc.encrypt("same");
    const b = svc.encrypt("same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.encryptedKey).not.toBe(b.encryptedKey);
  });

  it("detects tampering via GCM auth tag", () => {
    const svc = new EncryptionService(KEY);
    const enc = svc.encrypt("data");
    const tampered = { ...enc, encryptedKey: Buffer.from("tampered!").toString("base64") };
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it("rejects weak or malformed master keys", () => {
    expect(() => new EncryptionService("short")).toThrow();
    expect(() => new EncryptionService("zz".repeat(32))).toThrow();
  });
});

describe("extract helpers", () => {
  it("pickNumber tries candidates in order and coerces numeric strings", () => {
    expect(pickNumber({ a: "12", b: 5 }, ["b", "a"])).toBe(5);
    expect(pickNumber({ a: "12" }, ["b", "a"])).toBe(12);
    expect(pickNumber({ a: "nope" }, ["a"])).toBeNull();
    expect(pickNumber({}, ["x"])).toBeNull();
  });

  it("sourceRef composes and skips empties", () => {
    expect(sourceRef(["torn_log", 123])).toBe("torn_log:123");
    expect(sourceRef(["a", null, undefined, "", "b"])).toBe("a:b");
  });

  it("stripHtml strips tags and entities", () => {
    expect(stripHtml("You <strong>won</strong> $1,000 &amp; smiled")).toBe("You won $1,000 & smiled");
  });
});

describe("normalizeLogEntry", () => {
  const ctx: NormalizeContext = { itemNameById: new Map([[196, "Cannabis"]]) };

  function log(overrides: Partial<TornUserLog> & { id: number; timestamp: number }): TornUserLog {
    return {
      details: { id: 360, title: "Used drug", category: "Item use drug" },
      data: {},
      params: {},
      ...overrides,
    } as TornUserLog;
  }

  it("routes a drug log to a drug event + timeline, outcome success", () => {
    const writes = normalizeLogEntry(
      log({ id: 101, timestamp: 1_700_000_000, data: { item: { id: 196 } } }),
      ctx
    );
    expect(writes.drugEvents).toHaveLength(1);
    expect(writes.drugEvents[0]).toMatchObject({ drugItemId: 196, drugName: "Cannabis", outcome: "success" });
    expect(writes.timelineEvents).toHaveLength(1);
    expect(writes.moneyEvents).toHaveLength(0);
  });

  it("detects overdoses from the log title", () => {
    const writes = normalizeLogEntry(
      log({ id: 102, timestamp: 1_700_000_000, details: { id: 361, title: "Overdosed on drug", category: "Item use drug" }, data: { drug: 200 } }),
      ctx
    );
    expect(writes.drugEvents[0]!.outcome).toBe("overdose");
  });

  it("keeps unknown drug ids as null without inventing names", () => {
    const writes = normalizeLogEntry(log({ id: 103, timestamp: 1_700_000_000, data: { drug: 424242 } }), ctx);
    expect(writes.drugEvents[0]!.drugItemId).toBe(424242);
    expect(writes.drugEvents[0]!.drugName).toBeNull();
  });

  it("routes a money log with an amount into the ledger", () => {
    const writes = normalizeLogEntry(
      log({ id: 104, timestamp: 1_700_000_000, details: { id: 140, title: "Mugged someone", category: "Money mugging" }, data: { amount: 55_000 } }),
      ctx
    );
    expect(writes.moneyEvents).toHaveLength(1);
    expect(writes.moneyEvents[0]!.amount).toBe(55_000n);
    expect(writes.moneyEvents[0]!.direction).toBe("income");
    expect(writes.moneyEvents[0]!.category).toBe("mugging");
  });

  it("treats spent money as expense with negative amount", () => {
    const writes = normalizeLogEntry(
      log({ id: 105, timestamp: 1_700_000_000, details: { id: 141, title: "Paid for item", category: "Money items" }, data: { amount: 12_000 } }),
      ctx
    );
    expect(writes.moneyEvents[0]!.amount).toBe(-12_000n);
    expect(writes.moneyEvents[0]!.direction).toBe("expense");
  });

  it("routes rehab logs with cost into rehab + ledger", () => {
    const writes = normalizeLogEntry(
      log({ id: 106, timestamp: 1_700_000_000, details: { id: 370, title: "Rehabilitation", category: "Drug rehabilitation" }, data: { cost: 60_000, percentage: 25 } }),
      ctx
    );
    expect(writes.rehabEvents[0]).toMatchObject({ cost: 60_000n, rehabPercent: 25 });
    expect(writes.moneyEvents[0]!.amount).toBe(-60_000n);
    expect(writes.moneyEvents[0]!.category).toBe("rehab");
  });

  it("routes travel item purchases into travel items + ledger expense", () => {
    const writes = normalizeLogEntry(
      log({
        id: 107,
        timestamp: 1_700_000_000,
        details: { id: 380, title: "Bought item abroad", category: "Travel abroad" },
        data: { item: { id: 445 }, qty: 10, total: 200_000, country: "Argentina" },
      }),
      ctx
    );
    expect(writes.travelItemEvents[0]).toMatchObject({ itemId: 445, quantity: 10, totalCost: 200_000n, destination: "Argentina" });
    expect(writes.moneyEvents[0]!.amount).toBe(-200_000n);
  });

  it("records unmapped categories on the timeline only", () => {
    const writes = normalizeLogEntry(
      log({ id: 108, timestamp: 1_700_000_000, details: { id: 999, title: "Something else", category: "Mysterious future category" } }),
      ctx
    );
    expect(writes.unmapped).toBe(1);
    expect(writes.timelineEvents).toHaveLength(1);
    expect(writes.drugEvents).toHaveLength(0);
  });
});

describe("normalizeTornEvent", () => {
  it("strips HTML into a title/description", () => {
    const input = { id: 55, timestamp: 1_700_000_000, event: "You <b>won</b> the war &amp; gained respect" };
    const timeline = normalizeTornEvent(input);
    expect(timeline.type).toBe("torn_event");
    expect(timeline.title).toBe("You won the war & gained respect");
    expect(timeline.sourceRef).toBe("torn_event:55");
  });
});
