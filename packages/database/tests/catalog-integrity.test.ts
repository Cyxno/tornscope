import { describe, expect, it, beforeAll } from "vitest";
import { getPrismaClient, upsertCatalogEntries } from "../src/index.js";

/**
 * Item-valuation integrity:
 * - the TornItemCatalog is GLOBAL (shared by every profile), so the demo
 *   seed must never write to it — a demo fixture price (Xanax $45k) once
 *   overwrote the real market price for ALL production analytics;
 * - a catalog upsert with a missing price must never wipe a stored price
 *   (COALESCE guard).
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? "";
const suite = dbUrl ? describe : describe.skip;

const db = getPrismaClient();

const TEST_ITEM = 9_999_001;

beforeAll(async () => {
  // Start from a known price.
  await upsertCatalogEntries(db, [{ itemId: TEST_ITEM, name: "Valuation Test Item", type: "Other", marketPrice: BigInt(850_000) }]);
});

suite("catalog price integrity", () => {
  it("a null source price never wipes a stored market price", async () => {
    await upsertCatalogEntries(db, [{ itemId: TEST_ITEM, name: "Valuation Test Item", type: "Other", marketPrice: null }]);
    const row = await db.tornItemCatalog.findUnique({ where: { itemId: TEST_ITEM } });
    expect(row?.marketPrice).toBe(850_000n);
  });

  it("a fresh source price replaces the stored one and bumps freshness", async () => {
    const before = await db.tornItemCatalog.findUnique({ where: { itemId: TEST_ITEM } });
    await new Promise((r) => setTimeout(r, 20));
    await upsertCatalogEntries(db, [{ itemId: TEST_ITEM, name: "Valuation Test Item", type: "Other", marketPrice: BigInt(900_000) }]);
    const after = await db.tornItemCatalog.findUnique({ where: { itemId: TEST_ITEM } });
    expect(after?.marketPrice).toBe(900_000n);
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
  });

  it("the demo seed never writes to the shared catalog (source-level guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const seedSource = readFileSync(fileURLToPath(new URL("../src/seed/demo.ts", import.meta.url)), "utf8");
    expect(seedSource).not.toMatch(/upsertCatalogEntries\s*\(/);
    expect(seedSource).toContain("ISOLATION");
  });
});
