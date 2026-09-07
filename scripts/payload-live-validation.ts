/**
 * One-off READ-ONLY validation of the redesigned API payloads against the
 * live owner dataset: drugs (xanax funding buckets), dashboard (cash
 * received breakdown + reconciliation), faction OCs (tier/slots/states),
 * travel (categories + top items). Never writes.
 */
import { getPrismaClient } from "../packages/database/src/index.js";
import { getDrugsSummary } from "../apps/api/src/services/drugs.js";
import { getDashboard } from "../apps/api/src/services/dashboard.js";
import { getFactionOcs } from "../apps/api/src/services/faction.js";
import { getTravelSummary } from "../apps/api/src/services/travel.js";

async function main() {
  const db = getPrismaClient();
  const account = await db.tornAccount.findFirst({ orderBy: { lastSeenAt: "desc" }, select: { userId: true, tornId: true, name: true } });
  if (!account) throw new Error("no account");
  console.log(`owner: ${account.name} [${account.tornId}]`);

  const drugs = await getDrugsSummary(account.userId, { preset: "30d" }, null);
  console.log("\n--- Drugs 30D xanaxFunding ---");
  console.log(JSON.stringify(drugs.xanaxFunding, null, 1));

  const dashboard = await getDashboard(account.userId, { preset: "30d" });
  const cr = dashboard.financial.cashReceived;
  console.log("\n--- Dashboard 30D financial ---");
  console.log(`cashInflow=${dashboard.financial.cashInflow.value} cashOutflow=${dashboard.financial.cashOutflow.value} trueIncome=${dashboard.financial.trueIncome} assetSales=${dashboard.financial.assetSales}`);
  if (cr) {
    const sum = cr.earned.total + cr.assetSales.total + cr.other.total;
    console.log(`cashReceived: total=${cr.total} earned=${cr.earned.total} (ocPayouts=${cr.earned.ocPayouts}) assetSales=${cr.assetSales.total} other=${cr.other.total} unclassified=${cr.unclassified.total}x${cr.unclassified.count}`);
    console.log(`RECONCILES: ${sum === cr.total && cr.total === dashboard.financial.cashInflow.value}`);
    console.log(`earned rows: ${cr.earned.rows.map((r) => `${r.label}=${r.amount}`).join(", ")}`);
    console.log(`asset rows: ${cr.assetSales.rows.slice(0, 5).map((r) => `${r.label}=${r.amount}`).join(", ")}`);
  }

  const ocs = await getFactionOcs(account.userId, { preset: "90d" });
  const active = ocs.ocs.filter((o) => o.state === "active").slice(0, 3);
  console.log("\n--- Faction OCs (active sample) ---");
  for (const oc of active) {
    console.log(`${oc.name} tier=${oc.tier} status=${oc.status} slots=${oc.slotsFilled}/${oc.slotsTotal} planningAt=${oc.planningAt} readyAt=${oc.readyAt} mine=${oc.myParticipation} identifiable=${oc.participantsIdentifiable}`);
  }
  const completed = ocs.ocs.filter((o) => o.state === "completed")[0];
  if (completed) console.log(`completed sample: ${completed.name} tier=${completed.tier} status=${completed.status}`);

  const travel = await getTravelSummary(account.userId, { preset: "90d" });
  console.log("\n--- Travel 90D ---");
  console.log(`itemsByCategory: ${JSON.stringify(travel.itemsByCategory)}`);
  console.log(`topItems: ${JSON.stringify(travel.topItems.slice(0, 4))}`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
