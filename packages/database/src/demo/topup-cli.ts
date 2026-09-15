import { getPrismaClient } from "../client.js";
import { maybeTopUpDemoData } from "./topup.js";

/**
 * Manual demo top-up: `pnpm demo:topup` (from the repo root).
 *
 * Non-destructive routine freshness — the full reset remains
 * `pnpm demo:seed`. Pass --force to ignore the 6h throttle (useful after
 * restoring an older database copy).
 */
async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const db = getPrismaClient();
  if (force) {
    // Force = clear the throttle by pretending the last run is ancient.
    const demo = await db.user.findFirst({ where: { email: "demo@tornscope.local", isDemo: true }, select: { id: true } });
    if (demo) {
      await db.appSetting.updateMany({ where: { userId: demo.id, key: "demo_topup_watermark_at" }, data: { value: 0 } });
    }
  }
  const result = await maybeTopUpDemoData();
  console.log(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? Number(v) : v), 2));
  if (result.status === "error") process.exitCode = 1;
  await db.$disconnect();
}

void main();
