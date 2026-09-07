/**
 * One-off READ-ONLY validation: run the new provenance-aware Xanax ledger
 * against the live owner dataset for 7D/30D/90D and print the breakdown.
 * Never writes. Never logs key material.
 */
import { getPrismaClient } from "../packages/database/src/index.js";
import { classifyXanaxFunding, type XanaxAcquisition } from "../packages/analytics/src/index.js";

const OWNER_EMAIL = process.env.OWNER_EMAIL;
async function main() {
  const db = getPrismaClient();
  const account = await db.tornAccount.findFirst({
    orderBy: { lastSeenAt: "desc" },
    select: { userId: true, tornId: true, name: true },
  });
  if (!account) throw new Error("no torn account found");
  const userId = account.userId;
  const catalog = await db.tornItemCatalog.findFirst({ where: { name: { equals: "Xanax", mode: "insensitive" } }, select: { itemId: true } });
  const xanaxItemId = catalog?.itemId ?? 206;
  console.log(`owner: ${account.name} [${account.tornId}] userId=${userId} xanaxItemId=${xanaxItemId}`);

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86_400;

  // Ledger inputs — full history (range-independent).
  const [allUses, purchaseRows, travelRows, armoryRows, giftRows] = await Promise.all([
    db.drugEvent.findMany({
      where: { userId, OR: [{ drugName: { equals: "Xanax", mode: "insensitive" } }, { drugItemId: xanaxItemId }] },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    db.moneyEvent.findMany({
      where: {
        userId, direction: "expense", category: { in: ["bazaar", "items", "trading"] },
        metadata: { path: ["data", "items"], array_contains: [{ id: xanaxItemId }] },
      },
      select: { occurredAt: true, metadata: true },
    }),
    db.travelItemEvent.findMany({
      where: { userId, OR: [{ itemId: xanaxItemId }, { itemName: { equals: "Xanax", mode: "insensitive" } }] },
      select: { occurredAt: true, quantity: true, itemName: true, category: true },
    }),
    db.factionArmoryEvent.findMany({
      where: { userId, itemId: xanaxItemId, action: { in: ["used", "lent", "gave"] } },
      select: { memberId: true, action: true, occurredAt: true, quantity: true },
    }),
    db.timelineEvent.findMany({
      where: {
        userId,
        OR: [
          { title: { contains: "xanax", mode: "insensitive" } },
        ],
      },
      select: { occurredAt: true, title: true, metadata: true },
    }),
  ]);

  const acquisitions: XanaxAcquisition[] = [];
  for (const row of purchaseRows) {
    const meta = (row.metadata ?? {}) as { data?: { items?: Array<{ id?: number; qty?: number }> } };
    const qty = (meta.data?.items ?? []).filter((i) => i.id === xanaxItemId).reduce((s, i) => s + (typeof i.qty === "number" ? i.qty : 1), 0);
    if (qty > 0) acquisitions.push({ occurredAt: Math.floor(row.occurredAt.getTime() / 1000), units: qty, source: "personal_purchase" });
  }
  for (const row of travelRows) {
    if (row.occurredAt && row.quantity > 0) acquisitions.push({ occurredAt: Math.floor(row.occurredAt.getTime() / 1000), units: row.quantity, source: "travel_purchase" });
  }
  for (const log of giftRows) {
    const meta = JSON.stringify(log.metadata ?? {});
    if (!/xanax/i.test(meta) && !/xanax/i.test(log.title)) continue;
    if (/sent .* from /i.test(log.title)) acquisitions.push({ occurredAt: Math.floor(log.occurredAt.getTime() / 1000), units: 1, source: "gift" });
  }
  const armoryUseTimes: number[] = [];
  for (const e of armoryRows) {
    if (account.tornId !== null && e.memberId !== null && e.memberId !== account.tornId) continue;
    const t = Math.floor(e.occurredAt.getTime() / 1000);
    if (e.action === "used") for (let i = 0; i < e.quantity; i += 1) armoryUseTimes.push(t);
    else if (e.quantity > 0) acquisitions.push({ occurredAt: t, units: e.quantity, source: "faction_armory" });
  }

  const allUseTimes = allUses.map((u) => Math.floor(u.occurredAt.getTime() / 1000));
  console.log(`evidence: uses=${allUses.length} purchases=${acquisitions.filter((a) => a.source === "personal_purchase").reduce((s, a) => s + a.units, 0)}u travel=${acquisitions.filter((a) => a.source === "travel_purchase").reduce((s, a) => s + a.units, 0)}u gifts=${acquisitions.filter((a) => a.source === "gift").length} armoryUseEvidence=${armoryUseTimes.length} armoryWithdrawUnits=${acquisitions.filter((a) => a.source === "faction_armory").reduce((s, a) => s + a.units, 0)}`);
  const travelByCategory = travelRows.reduce<Record<string, number>>((acc, r) => { acc[r.category] = (acc[r.category] ?? 0) + 1; return acc; }, {});
  console.log(`travel xanax rows by current category: ${JSON.stringify(travelByCategory)}`);

  for (const days of [7, 30, 90]) {
    const from = now - days * DAY;
    const uses = allUseTimes.filter((t) => t >= from);
    const pre = allUseTimes.filter((t) => t < from);
    const r = classifyXanaxFunding({ uses: uses.map((t) => ({ occurredAt: t })), acquisitions, preRangeUses: pre.map((t) => ({ occurredAt: t })), armoryUseTimes, rangeFrom: from });
    const total = r.confirmedPersonal + r.confirmedFaction + r.confirmedOther + r.openingInventoryUnknown + r.unknown;
    console.log(
      `\n${days}D: used=${uses.length} (classified=${total})\n` +
      `  confirmed_faction=${r.confirmedFaction}\n` +
      `  confirmed_personal=${r.confirmedPersonal}\n` +
      `  confirmed_other(gifts)=${r.confirmedOther}\n` +
      `  opening_inventory_unknown=${r.openingInventoryUnknown}\n` +
      `  unknown=${r.unknown}\n` +
      `  openingStock=${JSON.stringify(r.openingStock)}\n` +
      `  earliestEvidenceAt=${r.earliestEvidenceAt ? new Date(r.earliestEvidenceAt * 1000).toISOString() : null} hasPreRangeEvidence=${r.hasPreRangeEvidence}`
    );
  }
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
