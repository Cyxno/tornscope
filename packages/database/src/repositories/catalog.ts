import { Prisma, PrismaClient } from "../generated/client/client.js";
import type { PrismaClientType } from "../client.js";
import { TORN_DRUG_NAMES } from "@tornscope/shared";

/**
 * Torn item catalog cache. The public /torn/items endpoint provides item
 * names and market prices; the catalog is used to resolve names (e.g. drug
 * item ids from logs) and to derive clearly-labeled estimated resale values.
 */

export interface CatalogEntry {
  itemId: number;
  name: string;
  type: string;
  marketPrice: bigint | null;
}

/** Bulk-upsert catalog entries with parameterized INSERT tuples. */
export async function upsertCatalogEntries(db: PrismaClientType, entries: CatalogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const chunkSize = 400;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    const values = Prisma.join(
      chunk.map((e) => Prisma.sql`(${e.itemId}, ${e.name}, ${e.type}, ${e.marketPrice}, now())`)
    );
    await db.$executeRaw(
      Prisma.sql`
        INSERT INTO "TornItemCatalog" ("itemId", "name", "type", "marketPrice", "updatedAt")
        VALUES ${values}
        ON CONFLICT ("itemId")
        DO UPDATE SET "name" = EXCLUDED."name", "type" = EXCLUDED."type",
                      "marketPrice" = EXCLUDED."marketPrice", "updatedAt" = now()
      `
    );
  }
}

/** itemId -> name map for normalizers. */
export async function loadItemNameMap(db: PrismaClientType): Promise<Map<number, string>> {
  const items = await db.tornItemCatalog.findMany({ select: { itemId: true, name: true } });
  return new Map(items.map((i) => [i.itemId, i.name]));
}

/** itemId -> catalog type ("Plushie", "Flower", ...) for normalizers. */
export async function loadItemTypeMap(db: PrismaClientType): Promise<Map<number, string>> {
  const items = await db.tornItemCatalog.findMany({ select: { itemId: true, type: true } });
  return new Map(items.map((i) => [i.itemId, i.type]));
}

/** market price by item id (null when unknown - never guess). */
export async function loadMarketPrices(db: PrismaClientType): Promise<Map<number, bigint>> {
  const items = await db.tornItemCatalog.findMany({
    where: { marketPrice: { not: null } },
    select: { itemId: true, marketPrice: true },
  });
  return new Map(items.filter((i) => i.marketPrice !== null).map((i) => [i.itemId, i.marketPrice as bigint]));
}

/** Item ids for the well-known drug names (from cached catalog). */
export async function findDrugItemIds(db: PrismaClientType, names: readonly string[] = TORN_DRUG_NAMES): Promise<Map<string, number>> {
  const items = await db.tornItemCatalog.findMany({
    where: { name: { in: [...names] } },
    select: { itemId: true, name: true },
  });
  return new Map(items.map((i) => [i.name, i.itemId]));
}

export async function getItemCatalogUpdatedAt(db: PrismaClient): Promise<Date | null> {
  const any = await db.tornItemCatalog.findFirst({ orderBy: { updatedAt: "desc" }, select: { updatedAt: true } });
  return any?.updatedAt ?? null;
}
