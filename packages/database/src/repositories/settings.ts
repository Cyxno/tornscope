import type { PrismaClientType } from "../client.js";

/** App settings helpers. userId = "" denotes global settings. */

export async function getSetting<T>(db: PrismaClientType, key: string, userId = ""): Promise<T | null> {
  const row = await db.appSetting.findUnique({
    where: { userId_key: { userId, key } },
  });
  return (row?.value as T | undefined) ?? null;
}

export async function setSetting<T>(db: PrismaClientType, key: string, value: T, userId = ""): Promise<void> {
  await db.appSetting.upsert({
    where: { userId_key: { userId, key } },
    create: { userId, key, value: value as object },
    update: { value: value as object },
  });
}

export async function deleteSetting(db: PrismaClientType, key: string, userId = ""): Promise<void> {
  await db.appSetting.deleteMany({ where: { userId, key } });
}

/** Cached /torn/logcategories payload (id + title). */
export interface CachedLogCategory {
  id: number;
  title: string;
}

export const LOG_CATEGORIES_CACHE_KEY = "torn_log_categories";

export async function getLogCategories(db: PrismaClientType): Promise<CachedLogCategory[] | null> {
  return getSetting<CachedLogCategory[]>(db, LOG_CATEGORIES_CACHE_KEY);
}

export async function setLogCategories(db: PrismaClientType, categories: CachedLogCategory[]): Promise<void> {
  await setSetting(db, LOG_CATEGORIES_CACHE_KEY, categories);
}
