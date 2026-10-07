import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPrismaClient } from "../src/index.js";
import { routeLog, moneyPlanFor } from "../src/normalizers/titles.js";
import { signMoneyLog } from "../src/normalizers/logs.js";

/**
 * Vault transfer + ammo coverage (2.6.0) — DB-backed against the
 * deterministic test lifecycle.
 *
 * Proves:
 * - Vault logs route to the money ledger as NEUTRAL transfers (live routing).
 * - The historical repair backfills them idempotently (rerun = 0 new).
 * - Vault rows never enter income/expense (accounting neutrality).
 * - Ammo buys normalize as expenses (coverage-only).
 */

const db = getPrismaClient();
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;
const REPAIR_SCRIPT = fileURLToPath(new URL("../src/repair/money-transfers.ts", import.meta.url));
const suffix = randomBytes(5).toString("hex");
let userId = "";

function ref(n: number): string {
  return `test:vault260:${suffix}:${n}`;
}

async function insertTimeline(category: string, title: string, occurredAt: Date, data: Record<string, unknown>, sourceRef: string): Promise<void> {
  await db.timelineEvent.create({
    data: { userId, occurredAt, type: "log", category, title, metadata: { data }, sourceRef, source: "test" },
  });
}

suite("money-transfer repair (vault + ammo)", () => {
  beforeAll(async () => {
    userId = (await db.user.create({ data: { email: `vault260-${suffix}@tornscope.local`, displayName: "Vault260", role: "user" } })).id;
  });

  afterAll(async () => {
    await db.user.deleteMany({ where: { email: `vault260-${suffix}@tornscope.local` } }).catch(() => undefined);
    await db.$disconnect();
  });

  it("routes vault logs to the money ledger as neutral transfers (live path)", () => {
    expect(routeLog("Vault", "Vault deposit")).toBe("money");
    expect(routeLog("Vault", "Vault withdraw")).toBe("money");
    const plan = moneyPlanFor("Vault", "Vault deposit");
    expect(plan).toMatchObject({ category: "vault", direction: "neutral", transfer: true, skip: false });
    // Canonical signed-cash reading: deposit leaves the wallet, withdraw enters it.
    expect(signMoneyLog("Vault", "Vault deposit", { deposited: 500 }, {}).amount).toBe(-500);
    expect(signMoneyLog("Vault", "Vault withdraw", { withdrawn: 300 }, {}).amount).toBe(300);
  });

  it("backfills vault transfers idempotently and keeps them neutral", async () => {
    const now = Math.floor(Date.now() / 1000);
    await insertTimeline("Vault", "Vault deposit", new Date((now - 3600) * 1000), { balance: 1_000, deposited: 400, property_id: 42 }, ref(1));
    await insertTimeline("Vault", "Vault withdraw", new Date((now - 1800) * 1000), { balance: 1_700, withdrawn: 700, property_id: 42 }, ref(2));
    await insertTimeline("Ammo", "Ammo buy", new Date((now - 900) * 1000), { ammo: 5, quantity: 2, value: 36 }, ref(3));

    const runRepair = (dryRun: boolean): string =>
      execFileSync("pnpm", ["--filter", "@tornscope/database", "exec", "tsx", REPAIR_SCRIPT, ...(dryRun ? ["--dry-run"] : [])], {
        env: { ...process.env, DATABASE_URL: dbUrl },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    // Dry-run reports, applies nothing.
    const dry = runRepair(true);
    expect(dry).toContain("Candidate raw logs: 3");
    expect(dry).toContain("DRY RUN");
    expect(await db.moneyEvent.count({ where: { userId, sourceRef: { in: [ref(1), ref(2), ref(3)] } } })).toBe(0);

    // Apply.
    const applied = runRepair(false);
    expect(applied).toContain("Repair applied: 3");
    const rows = await db.moneyEvent.findMany({ where: { userId, sourceRef: { in: [ref(1), ref(2), ref(3)] } }, orderBy: { occurredAt: "asc" } });
    expect(rows).toHaveLength(3);

    const deposit = rows.find((r) => r.sourceRef === ref(1))!;
    expect(deposit).toMatchObject({ category: "vault", direction: "neutral", amount: -400n, subcategory: "Vault deposit" });
    const metadata = deposit.metadata as { balanceAfter?: number; propertyId?: number };
    expect(metadata.balanceAfter).toBe(1_000);
    expect(metadata.propertyId).toBe(42);

    const withdraw = rows.find((r) => r.sourceRef === ref(2))!;
    expect(withdraw).toMatchObject({ category: "vault", direction: "neutral", amount: 700n, subcategory: "Vault withdraw" });

    const ammo = rows.find((r) => r.sourceRef === ref(3))!;
    expect(ammo).toMatchObject({ category: "ammo", direction: "expense", amount: -36n });
    expect((ammo.metadata as { quantity?: number }).quantity).toBe(2);

    // Accounting neutrality: vault rows are neutral — never income/expense.
    expect(rows.filter((r) => r.category === "vault").every((r) => r.direction === "neutral")).toBe(true);

    // Rerun converges: 0 candidates, no new rows.
    const rerun = runRepair(false);
    expect(rerun).toContain("Candidate raw logs: 0");
    expect(await db.moneyEvent.count({ where: { userId, sourceRef: { in: [ref(1), ref(2), ref(3)] } } })).toBe(3);
  });
});
