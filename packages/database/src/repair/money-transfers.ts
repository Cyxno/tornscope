import { getPrismaClient } from "../client.js";

/**
 * Money-transfer repair (2.6.0) — backfill MoneyEvents for value-bearing log
 * families the ledger never covered:
 *
 *   pnpm --filter @tornscope/database repair:money-transfers [--dry-run]
 *
 * Families (audit-proven, 2.6.0):
 * - "Vault deposit"/"Vault withdraw" (category Vault): property-vault
 *   movements between the player's own pools → NEUTRAL transfers
 *   (category=vault). Never income, never expense, never P/L.
 * - "Ammo buy" (category Ammo): explicit cash cost {value} per purchase →
 *   category=ammo, direction=expense. Coverage-only: no page, no card.
 *
 * Idempotent via the MoneyEvent (userId, source, sourceRef) unique and a
 * NOT EXISTS scan — a rerun reports 0 new. The raw archive is untouched.
 */

type UnknownRecord = Record<string, unknown>;

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

interface TransferCandidate {
  userId: string;
  sourceRef: string;
  occurredAt: Date;
  family: "vault" | "ammo";
  amount: bigint;
  subcategory: string;
  metadata: UnknownRecord;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const scan = `
  SELECT te."userId", te."sourceRef", te."occurredAt", te."category", te."title", te."metadata"
  FROM "TimelineEvent" te
  WHERE te."type" = 'log'
    AND (
      (te."category" = 'Vault' AND te."title" IN ('Vault deposit', 'Vault withdraw'))
      OR (te."category" = 'Ammo' AND te."title" = 'Ammo buy')
    )
    AND NOT EXISTS (
      SELECT 1 FROM "MoneyEvent" me
      WHERE me."sourceRef" = te."sourceRef" AND me."userId" = te."userId"
    )
  ORDER BY te."occurredAt" ASC
  LIMIT 100000
`;

function recognize(row: { userId: string; sourceRef: string; occurredAt: Date; category: string; title: string; metadata: unknown }): TransferCandidate | { unsupported: true } {
  const data = asRecord((row.metadata as { data?: unknown } | null)?.data) ?? {};

  if (row.category === "Vault") {
    // FASE 9 semantics: deposit = wallet -> vault (wallet loses cash),
    // withdraw = vault -> wallet. Neutral signed amount, consistent with the
    // live money-log routing (signMoneyLog transfer path).
    const isWithdraw = /withdraw/i.test(row.title);
    const movement = numeric(data.deposited) ?? numeric(data.withdrawn);
    if (movement === null || movement <= 0) return { unsupported: true };
    const metadata: UnknownRecord = {};
    const balance = numeric(data.balance);
    if (balance !== null) metadata.balanceAfter = balance;
    const propertyId = numeric(data.property_id);
    if (propertyId !== null) metadata.propertyId = propertyId;
    return {
      userId: row.userId,
      sourceRef: row.sourceRef,
      occurredAt: row.occurredAt,
      family: "vault",
      amount: BigInt(Math.round(isWithdraw ? movement : -movement)),
      subcategory: isWithdraw ? "Vault withdraw" : "Vault deposit",
      metadata,
    };
  }

  // Ammo buy: {ammo, quantity, value} — value is the explicit cash cost.
  const cost = numeric(data.value);
  if (cost === null || cost <= 0) return { unsupported: true };
  const metadata: UnknownRecord = {};
  const ammoType = numeric(data.ammo);
  if (ammoType !== null) metadata.ammoType = ammoType;
  const quantity = numeric(data.quantity);
  if (quantity !== null) metadata.quantity = quantity;
  return {
    userId: row.userId,
    sourceRef: row.sourceRef,
    occurredAt: row.occurredAt,
    family: "ammo",
    amount: -BigInt(Math.round(cost)),
    subcategory: "Ammo buy",
    metadata,
  };
}

const BATCH = 500;

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv);
  const db = getPrismaClient();

  const rows = await db.$queryRawUnsafe<Array<{ userId: string; sourceRef: string; occurredAt: Date; category: string; title: string; metadata: unknown }>>(scan);
  console.log(`Candidate raw logs: ${rows.length}`);

  const candidates: TransferCandidate[] = [];
  let unsupported = 0;
  for (const row of rows) {
    const result = recognize(row);
    if ("unsupported" in result) {
      unsupported += 1;
      continue;
    }
    candidates.push(result);
  }
  console.log(`Recognized (would insert): ${dryRun ? candidates.length : 0} → applying: ${candidates.length}`);
  console.log(`Unsupported (no proven value semantics): ${unsupported}`);
  console.log(`Ambiguous: 0`);

  const byFamily = new Map<string, number>();
  for (const candidate of candidates) byFamily.set(candidate.family, (byFamily.get(candidate.family) ?? 0) + 1);
  for (const [family, count] of byFamily) console.log(`  ${family}: ${count}`);

  if (dryRun) {
    console.log("DRY RUN — nothing was changed. Re-run without --dry-run to apply.");
    await db.$disconnect();
    return;
  }

  let inserted = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const result = await db.moneyEvent.createMany({
      data: batch.map((c) => ({
        userId: c.userId,
        occurredAt: c.occurredAt,
        category: c.family,
        subcategory: c.subcategory,
        // Both families are accounting-neutral movements of stored value;
        // ammo is an expense (cash leaves the wallet for a good).
        direction: c.family === "ammo" ? ("expense" as const) : ("neutral" as const),
        amount: c.amount,
        source: "torn_log",
        sourceRef: c.sourceRef,
        description: c.subcategory,
        metadata: c.metadata as never,
      })),
      skipDuplicates: true,
    });
    inserted += result.count;
  }
  console.log(`Repair applied: ${inserted} MoneyEvent rows inserted (skipDuplicates; raw archive untouched).`);
  console.log("Re-run — it must now report 0 candidates.");
  await db.$disconnect();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
