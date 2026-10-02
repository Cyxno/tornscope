import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { normalizeLogEntry } from "../src/normalizers/logs.js";
import { routeLog, moneyPlanFor } from "../src/normalizers/titles.js";
import { getPrismaClient } from "../src/client.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Cross-domain routing regression coverage (2.1.3): offshore bank
 * movements and travel fees are filed by Torn under the "Travel" category
 * but are money movements — the travel route must not shadow the ledger.
 * Also pins the ENTITY-NAME-MATCH ≠ EVENT-PROOF rule for money payloads.
 */

function normalize(title: string, category: string, data: Record<string, unknown>) {
  return normalizeLogEntry(
    { id: 1, timestamp: 1_750_000_000, details: { id: 1, title, category }, data, params: {} },
    { itemNameById: new Map(), itemIdByName: new Map() }
  );
}

describe("cross-domain routing: offshore bank & travel fees", () => {
  it("routes offshore bank movements and travel fees to money, not travel", () => {
    expect(routeLog("Travel", "Offshore bank deposit")).toBe("money");
    expect(routeLog("Travel", "Offshore bank withdraw")).toBe("money");
    expect(routeLog("Travel", "Travel fee")).toBe("money");
    // Real travel transitions unaffected.
    expect(routeLog("Travel", "Travel depart")).toBe("travel");
    expect(routeLog("Travel", "Travel arrive")).toBe("travel");
    expect(routeLog("Travel", "Rehab")).toBe("rehab");
  });

  it("offshore deposit is a cayman transfer OUT of the wallet, no travel transition", () => {
    const writes = normalize("Offshore bank deposit", "Travel", { balance: 738000, deposited: 70000 });
    expect(writes.moneyEvents).toHaveLength(1);
    expect(writes.moneyEvents[0]).toMatchObject({ category: "cayman_bank", direction: "neutral", amount: -70_000n });
    expect(writes.travelTransitions).toHaveLength(0);
    expect(moneyPlanFor("Travel", "Offshore bank deposit")?.transfer).toBe(true);
  });

  it("offshore withdraw is a cayman transfer INTO the wallet", () => {
    const writes = normalize("Offshore bank withdraw", "Travel", { balance: 0, withdrawn: 738000 });
    expect(writes.moneyEvents[0]).toMatchObject({ category: "cayman_bank", direction: "neutral", amount: 738_000n });
  });

  it("travel fee is a travel expense from its {cost} payload", () => {
    const writes = normalize("Travel fee", "Travel", { cost: 6500 });
    expect(writes.moneyEvents[0]).toMatchObject({ category: "travel", direction: "expense", amount: -6500n });
    expect(writes.travelTransitions).toHaveLength(0);
  });

  it("deposited/withdrawn keys alone never turn non-movement logs into money", () => {
    // The new payload keys only matter where the route already proves a
    // money movement — vault logs stay timeline-only (walk-scope decision).
    expect(routeLog("Vault", "Vault deposit")).toBe("timeline");
  });
});

/* -------------------------------------------------------------------------- */
/* Additive repair (DB-backed)                                                 */
/* -------------------------------------------------------------------------- */

const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;
const db = getPrismaClient();
const REPAIR_SCRIPT = fileURLToPath(new URL("../src/repair/money-gaps.ts", import.meta.url));

function runRepair(extra: string[] = []): string {
  return execFileSync("pnpm", ["--filter", "@tornscope/database", "exec", "tsx", REPAIR_SCRIPT, ...extra], {
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let userId: string;

suite("money-gap repair (DB-backed)", () => {
  beforeAll(async () => {
    userId = (await db.user.create({ data: { displayName: `MGAP-${randomUUID().slice(0, 8)}`, role: "user" } })).id;
    const base = 1_750_000_000;
    await db.timelineEvent.createMany({
      data: [
        { userId, occurredAt: new Date(base * 1000), type: "log", category: "Travel", title: "Offshore bank deposit", source: "torn_log", sourceRef: "mgap:dep", metadata: { id: 1, timestamp: base, details: { id: 1, title: "Offshore bank deposit", category: "Travel" }, data: { balance: 738000, deposited: 70000 } } },
        { userId, occurredAt: new Date((base + 60) * 1000), type: "log", category: "Travel", title: "Travel fee", source: "torn_log", sourceRef: "mgap:fee", metadata: { id: 2, timestamp: base + 60, details: { id: 2, title: "Travel fee", category: "Travel" }, data: { cost: 6500 } } },
      ],
    });
  });

  afterAll(async () => {
    await db.moneyEvent.deleteMany({ where: { userId } });
    await db.timelineEvent.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it("inserts the missing MoneyEvents additively", () => {
    const out = runRepair();
    expect(out).toContain("missing MoneyEvents to insert: 2");
    expect(out).not.toContain("DRY RUN");
  });

  it("created rows carry the proven direction and category", async () => {
    const dep = await db.moneyEvent.findFirst({ where: { userId, sourceRef: "mgap:dep" } });
    expect(dep).toMatchObject({ category: "cayman_bank", direction: "neutral" });
    expect(dep!.amount).toBe(-70_000n);
    const fee = await db.moneyEvent.findFirst({ where: { userId, sourceRef: "mgap:fee" } });
    expect(fee).toMatchObject({ category: "travel", direction: "expense" });
    expect(fee!.amount).toBe(-6500n);
  });

  it("second run inserts nothing (idempotent)", () => {
    const out = runRepair();
    expect(out).toContain("Nothing to repair");
    expect(db.moneyEvent.count({ where: { userId } })).resolves.toBe(2);
  });

  it("dry-run mutates nothing", () => {
    const out = runRepair(["--dry-run"]);
    expect(out).toContain("Nothing to repair");
    expect(db.moneyEvent.count({ where: { userId } })).resolves.toBe(2);
  });
});
