import { PrismaClient } from "./generated/client/client.js";

export type PrismaClientType = PrismaClient;

export { Prisma } from "./generated/client/client.js";
export * from "./generated/client/models.js";

let singleton: PrismaClient | undefined;

/** Shared Prisma client (one per process). */
export function getPrismaClient(): PrismaClient {
  if (!singleton) {
    singleton = new PrismaClient();
  }
  return singleton;
}

/** Convert a Prisma BigInt to a JS number safely for API boundaries. */
export function bigintToNumber(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    // Torn money values stay far below 2^53 in practice; flag rather than
    // silently lose precision.
    return Number(value);
  }
  return n;
}
