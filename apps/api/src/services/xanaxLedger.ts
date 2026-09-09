import { classifyXanaxFunding, type XanaxAcquisition, type XanaxFundingClassification } from "@tornscope/analytics";
import { getPrismaClient } from "@tornscope/database";

/**
 * Xanax funding ledger (shared by the Drugs page and the Daily Summary).
 *
 * Gathered across the FULL recorded history (only capped at the range end):
 * acquisitions before the range feed opening stock, and provenance must never
 * change just because the caller's display range changed. The classification
 * itself is the canonical `classifyXanaxFunding` from @tornscope/analytics.
 */

/** Xanax item id + catalog freshness (authoritative name match at runtime). */
export async function resolveXanaxItem(db: ReturnType<typeof getPrismaClient>): Promise<{ itemId: number; priceUpdatedAt: Date } | null> {
  const row = await db.tornItemCatalog.findFirst({
    where: { name: { equals: "Xanax", mode: "insensitive" } },
    select: { itemId: true, updatedAt: true },
  });
  return row ? { itemId: row.itemId, priceUpdatedAt: row.updatedAt } : null;
}

export interface XanaxLedgerInput {
  /** Display range start (unix seconds) — pre-range uses prove opening stock. */
  from: number;
  to: number;
  xanaxItemId: number | null;
  /** In-range Xanax uses to classify (unix seconds). */
  xanaxUses: Array<{ occurredAt: number }>;
  /** Current catalog market prices (itemId → unit price). */
  priceMap: Map<number, number>;
}

export interface XanaxLedger {
  funding: XanaxFundingClassification;
  acquisitions: XanaxAcquisition[];
  /** Faction armory "used" events attributable to this profile. */
  armoryEventsToOwner: number;
  armoryAvailable: boolean;
  armoryEarliestAt: number | null;
  /** Current catalog unit price (null without catalog coverage). */
  unitPrice: number | null;
}

export async function buildXanaxLedger(db: ReturnType<typeof getPrismaClient>, userId: string, input: XanaxLedgerInput): Promise<XanaxLedger> {
  const { from, to, xanaxItemId, xanaxUses, priceMap } = input;
  const [supplyLogs, purchaseRows, travelPurchaseRows, armoryRows, earliestArmory, owner] = await Promise.all([
    db.timelineEvent.findMany({
      where: {
        userId,
        occurredAt: { lte: new Date(to * 1000) },
        OR: [
          { title: { contains: "loan item", mode: "insensitive" } },
          { title: { contains: "armory", mode: "insensitive" } },
          { title: { contains: "xanax", mode: "insensitive" } },
        ],
      },
      select: { occurredAt: true, title: true, metadata: true },
    }),
    xanaxItemId !== null
      ? db.moneyEvent.findMany({
          where: {
            userId,
            direction: "expense",
            category: { in: ["bazaar", "items", "trading"] },
            occurredAt: { lte: new Date(to * 1000) },
            metadata: { path: ["data", "items"], array_contains: [{ id: xanaxItemId }] },
          },
          select: { occurredAt: true, metadata: true },
        })
      : Promise.resolve([] as Array<{ occurredAt: Date; metadata: unknown }>),
    xanaxItemId !== null
      ? db.travelItemEvent.findMany({
          where: { userId, itemId: xanaxItemId, occurredAt: { lte: new Date(to * 1000) } },
          select: { occurredAt: true, quantity: true },
        })
      : Promise.resolve([] as Array<{ occurredAt: Date; quantity: number }>),
    xanaxItemId !== null
      ? db.factionArmoryEvent.findMany({
          where: { userId, itemId: xanaxItemId, action: { in: ["used", "lent", "gave"] } },
          select: { memberId: true, action: true, occurredAt: true, quantity: true },
          orderBy: { occurredAt: "asc" },
        })
      : Promise.resolve([] as Array<{ memberId: number | null; action: string; occurredAt: Date; quantity: number }>),
    db.factionArmoryEvent.findFirst({ where: { userId }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true } }),
    db.tornAccount.findUnique({ where: { userId }, select: { tornId: true } }),
  ]);

  const isOwnerRow = (memberId: number | null): boolean =>
    owner?.tornId === null || owner?.tornId === undefined || memberId === null || memberId === owner.tornId;

  const acquisitions: XanaxAcquisition[] = [];
  // Personal purchases: money logs carry exact item ids (bazaar/item market/
  // trades). Every unit is one acquisition event in the ledger.
  for (const row of purchaseRows) {
    const meta = (row.metadata ?? {}) as { data?: { items?: Array<{ id?: number; qty?: number }> } };
    const qty = (meta.data?.items ?? []).filter((i) => i.id === xanaxItemId).reduce((s, i) => s + (typeof i.qty === "number" ? i.qty : 1), 0);
    if (qty > 0) acquisitions.push({ occurredAt: Math.floor(row.occurredAt.getTime() / 1000), units: qty, source: "personal_purchase" });
  }
  // Travel purchases: Xanax bought abroad is a first-class acquisition record
  // with exact quantity (never double-counted — money logs for abroad buys
  // use the "travel" category, not bazaar/items/trading).
  for (const row of travelPurchaseRows) {
    if (row.quantity > 0) acquisitions.push({ occurredAt: Math.floor(row.occurredAt.getTime() / 1000), units: row.quantity, source: "travel_purchase" });
  }
  // Gifts: explicit evidence of an external (non-personal, non-faction) source.
  for (const log of supplyLogs) {
    const meta = JSON.stringify(log.metadata ?? {});
    const mentionsXanax = meta.includes(`"${xanaxItemId}"`) || /xanax/i.test(meta) || /xanax/i.test(log.title);
    if (!mentionsXanax) continue;
    if (/^faction/i.test(log.title)) continue; // armory table is the authoritative faction source
    if (/sent .* from /i.test(log.title)) acquisitions.push({ occurredAt: Math.floor(log.occurredAt.getTime() / 1000), units: 1, source: "gift" });
  }
  // Faction armory withdrawals to THIS member (lent/gave) are faction-source
  // acquisitions; "used" actions are use-time sponsorship evidence.
  const armoryUseTimes: number[] = [];
  let armoryEventsToOwner = 0;
  for (const e of armoryRows) {
    if (!isOwnerRow(e.memberId)) continue;
    const t = Math.floor(e.occurredAt.getTime() / 1000);
    if (e.action === "used") {
      for (let i = 0; i < e.quantity; i += 1) armoryUseTimes.push(t);
      armoryEventsToOwner += 1;
    } else if (e.quantity > 0) {
      acquisitions.push({ occurredAt: t, units: e.quantity, source: "faction_armory" });
    }
  }
  // Uses before the selected range: prove possession and consume the
  // pre-range stock so opening inventory is real, not assumed.
  const preRangeUseRows =
    xanaxUses.length > 0
      ? await db.drugEvent.findMany({
          where: {
            userId,
            occurredAt: { lt: new Date(from * 1000) },
            OR: [{ drugName: { equals: "Xanax", mode: "insensitive" } }, ...(xanaxItemId !== null ? [{ drugItemId: xanaxItemId }] : [])],
          },
          select: { occurredAt: true },
        })
      : [];

  const funding = classifyXanaxFunding({
    uses: xanaxUses,
    acquisitions,
    preRangeUses: preRangeUseRows.map((r) => ({ occurredAt: Math.floor(r.occurredAt.getTime() / 1000) })),
    armoryUseTimes,
    rangeFrom: from,
  });

  return {
    funding,
    acquisitions,
    armoryEventsToOwner,
    armoryAvailable: armoryRows.length > 0,
    armoryEarliestAt: earliestArmory ? Math.floor(earliestArmory.occurredAt.getTime() / 1000) : null,
    unitPrice: xanaxItemId !== null ? priceMap.get(xanaxItemId) ?? null : null,
  };
}
