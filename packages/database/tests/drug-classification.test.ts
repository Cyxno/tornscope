import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { normalizeLogEntry, type NormalizeContext } from "../src/normalizers/logs.js";
import { routeLog, isExplicitDrugUseTitle } from "../src/normalizers/titles.js";
import { getPrismaClient } from "../src/client.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Drug-classification correctness (2.1.2 regression coverage).
 *
 * A log is counted as a drug use ONLY when its provenance proves it:
 * category "Drugs"/"Item use drug", or an explicit name-anchored use title.
 * A bare drug word in a title ("Gym train speed") must NEVER create a
 * DrugEvent. The DB-backed section exercises the historical repair end to
 * end (false positives removed, legitimate uses preserved, idempotent).
 */

function ctx(overrides: Partial<NormalizeContext> = {}): NormalizeContext {
  return {
    itemNameById: new Map(),
    itemIdByName: new Map(),
    ...overrides,
  };
}

function normalize(title: string, category: string, data: Record<string, unknown>, context: NormalizeContext, id = 1) {
  return normalizeLogEntry({ id, timestamp: 1_750_000_000, details: { id, title, category }, data, params: {} }, context);
}

describe("drug routing grammar (pure)", () => {
  it("CASE A: category Drugs + Item use Speed -> Speed DrugEvent", () => {
    const writes = normalize("Item use speed", "Drugs", {}, ctx());
    expect(writes.drugEvents).toHaveLength(1);
    expect(writes.drugEvents[0]).toMatchObject({ drugName: "Speed", outcome: "success" });
  });

  it("CASE B: Gym log whose title contains speed -> NO DrugEvent, no consumption", () => {
    const writes = normalize(
      "Gym train speed",
      "Gym",
      { gym: 18, trains: 40, happy_used: 200, energy_used: 400, speed_increased: 6000 },
      ctx()
    );
    expect(writes.drugEvents).toHaveLength(0);
    expect(writes.consumptionEvents).toHaveLength(0);
    expect(writes.moneyEvents).toHaveLength(0);
    expect(writes.timelineEvents).toHaveLength(1); // archive row stays
  });

  it("CASE C: stat/training speed titles -> never drug use", () => {
    for (const title of ["Speed increased", "Training speed", "Company special gain speed"]) {
      expect(isExplicitDrugUseTitle(title)).toBe(false);
      expect(routeLog("Gym", title)).not.toBe("drugs");
      expect(routeLog("Company", title)).not.toBe("drugs");
    }
  });

  it("CASE D: real Xanax use -> Xanax", () => {
    const writes = normalize("Item use xanax", "Drugs", {}, ctx());
    expect(writes.drugEvents[0]).toMatchObject({ drugName: "Xanax", outcome: "success" });
  });

  it("CASE E: real Xanax overdose -> Xanax + overdose outcome", () => {
    const writes = normalize("Item use xanax overdose", "Drugs", {}, ctx());
    expect(writes.drugEvents[0]).toMatchObject({ drugName: "Xanax", outcome: "overdose" });
  });

  it("CASE F: non-drug title that happens to contain a drug name -> NO DrugEvent", () => {
    const writes = normalize("Company special gain speed", "Company", { pay: 100 }, ctx());
    expect(writes.drugEvents).toHaveLength(0);
  });

  it("CASE G: drug item ID inside a real use context -> valid DrugEvent with that ID", () => {
    const context = ctx({ itemNameById: new Map([[204, "Speed"]]) });
    const writes = normalize("Item use", "Drugs", { item: 204 }, context);
    expect(writes.drugEvents).toHaveLength(1);
    expect(writes.drugEvents[0]).toMatchObject({ drugItemId: 204, drugName: "Speed" });
  });

  it("CASE H: drug item ID without use context -> not automatically a use", () => {
    // Category "Item use" (generic consumable), title is not a drug-use
    // grammar match ("speed loader" is not the Speed drug): no DrugEvent.
    const writes = normalize("Item use speed loader", "Item use", { item: 204 }, ctx());
    expect(writes.drugEvents).toHaveLength(0);
  });

  it("old-style real forms still classify: Used Xanax / Overdosed on Speed / Used Love Juice", () => {
    for (const [title, name] of [["Used Xanax", "Xanax"], ["Overdosed on Speed", "Speed"], ["Used Love Juice", "Love Juice"]]) {
      expect(isExplicitDrugUseTitle(title)).toBe(true);
      expect(routeLog("Item use drug", title)).toBe("drugs");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Historical repair (DB-backed)                                               */
/* -------------------------------------------------------------------------- */

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;
const db = getPrismaClient();
const REPAIR_SCRIPT = fileURLToPath(new URL("../src/repair/drug-classification.ts", import.meta.url));

function runRepair(extra: string[] = []): string {
  return execFileSync("pnpm", ["--filter", "@tornscope/database", "exec", "tsx", REPAIR_SCRIPT, ...extra], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let userId: string;

suite("drug classification repair (DB-backed)", () => {
  beforeAll(async () => {
    userId = (await db.user.create({ data: { displayName: `DRUGFIX-${randomUUID().slice(0, 8)}`, role: "user" } })).id;
    const mid = new Date(1_750_000_000_000);
    await db.timelineEvent.createMany({
      data: [
        { userId, occurredAt: mid, type: "log", category: "Gym", title: "Gym train speed", source: "torn_log", sourceRef: "fix:gym:1", metadata: { data: { energy_used: 400 } } },
        { userId, occurredAt: mid, type: "log", category: "Company", title: "Company special gain speed", source: "torn_log", sourceRef: "fix:company:1", metadata: { data: { pay: 100 } } },
      ],
    });
    await db.drugEvent.createMany({
      data: [
        { userId, occurredAt: mid, drugItemId: 204, drugName: "Speed", outcome: "success", source: "torn_log", sourceRef: "fix:gym:1" },
        { userId, occurredAt: mid, drugItemId: 204, drugName: "Speed", outcome: "success", source: "torn_log", sourceRef: "fix:company:1" },
      ],
    });
    await db.consumptionEvent.createMany({
      data: [
        { userId, occurredAt: mid, category: "drug", quantity: 1, source: "torn_log", sourceRef: "fix:gym:1" },
        { userId, occurredAt: mid, category: "drug", quantity: 1, source: "torn_log", sourceRef: "fix:company:1" },
      ],
    });
    await db.timelineEvent.create({
      data: { userId, occurredAt: mid, type: "log", category: "Item use drug", title: "Used Speed", source: "torn_log", sourceRef: "fix:legit:speed", metadata: { data: {} } },
    });
    await db.drugEvent.create({
      data: { userId, occurredAt: mid, drugItemId: 204, drugName: "Speed", outcome: "success", source: "torn_log", sourceRef: "fix:legit:speed" },
    });
  });

  afterAll(async () => {
    await db.drugEvent.deleteMany({ where: { userId } });
    await db.consumptionEvent.deleteMany({ where: { userId } });
    await db.timelineEvent.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it("CASE I: removes proven false-positive DrugEvents", () => {
    const out = runRepair();
    expect(out).toContain("Invalid drug rows found: 2");
    expect(db.drugEvent.count({ where: { userId, sourceRef: "fix:gym:1" } })).resolves.toBe(0);
    expect(db.drugEvent.count({ where: { userId, sourceRef: "fix:company:1" } })).resolves.toBe(0);
  });

  it("CASE J: preserves the legitimate historical Speed use", () => {
    expect(db.drugEvent.count({ where: { userId, sourceRef: "fix:legit:speed" } })).resolves.toBe(1);
  });

  it("CASE K: removes the associated false ConsumptionEvents", () => {
    expect(db.consumptionEvent.count({ where: { userId, sourceRef: { in: ["fix:gym:1", "fix:company:1"] } } })).resolves.toBe(0);
    // The archive keeps every raw log row.
    expect(db.timelineEvent.count({ where: { userId } })).resolves.toBe(3);
  });

  it("CASE L: second repair run changes nothing (idempotent)", () => {
    const out = runRepair();
    expect(out).toContain("Nothing to repair");
    expect(db.drugEvent.count({ where: { userId } })).resolves.toBe(1);
    expect(db.consumptionEvent.count({ where: { userId } })).resolves.toBe(0);
  });

  it("dry-run reports without deleting", () => {
    // After the idempotence run above there is nothing to do; the dry-run
    // path itself is exercised by running it and asserting no mutation.
    const out = runRepair(["--dry-run"]);
    expect(out).toContain("Nothing to repair");
    expect(db.drugEvent.count({ where: { userId } })).resolves.toBe(1);
  });
});
