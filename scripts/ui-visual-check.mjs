#!/usr/bin/env node
/**
 * TornScope UI visual + responsive check (v0.2 second-pass tooling).
 *
 * Captures full-page screenshots of the main routes at phone/tablet/desktop
 * widths against a RUNNING TornScope web instance, and fails on:
 *   - horizontal overflow (document.scrollWidth > document.clientWidth)
 *   - console errors / uncaught exceptions
 *   - failed network requests
 *
 * It is a developer tool, not part of CI: it needs a browser binary and a
 * live session cookie.
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:5273 COOKIE="ts_session=…" \
 *   node scripts/ui-visual-check.mjs [--out /tmp/tornscope-shots]
 *
 * Env:
 *   BASE_URL   web origin to test (default http://127.0.0.1:5273)
 *   COOKIE     session cookie as a "name=value" string (default: TS_SESSION env)
 *   WIDTHS     comma list (default 390,768,1280)
 *   ROUTES     comma list (default: the main nav routes + welcome)
 *
 * Requires `playwright-core` (or `playwright`) resolvable from anywhere, plus
 * a Chromium executable. If the browser complains about missing shared
 * libraries (seen on bare-metal Unraid), point LD_LIBRARY_PATH at a directory
 * containing libnss3/libnspr4, e.g.:
 *   LD_LIBRARY_PATH=/tmp/chrome-libs PLAYWRIGHT_MODULE=… node scripts/ui-visual-check.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5273";
const OUT = argFlag("--out") ?? "/tmp/tornscope-ui-check";
const WIDTHS = (process.env.WIDTHS ?? "390,768,1280").split(",").map(Number);
const ROUTES = (process.env.ROUTES ?? "/,/today,/money,/drugs,/travel,/crimes,/combat,/faction,/timeline,/sync,/settings,/welcome").split(",");
const EXE = process.env.PLAYWRIGHT_CHROMIUM ?? "/root/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell";

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sessionCookie() {
  const raw = process.env.COOKIE ?? process.env.TS_SESSION ?? "";
  const [name, ...rest] = raw.split("=");
  if (!name || rest.length === 0) {
    console.error("ui-visual-check: set COOKIE='ts_session=…' (a logged-in session for BASE_URL).");
    process.exit(2);
  }
  return { name, value: rest.join("=") };
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    // Not resolvable from this checkout: allow an explicit path, e.g.
    // PLAYWRIGHT_MODULE=/tmp/resp/node_modules/playwright-core/index.mjs
    const path = process.env.PLAYWRIGHT_MODULE;
    if (!path) {
      console.error("ui-visual-check: playwright-core not found. Install it or set PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs");
      process.exit(2);
    }
    ({ chromium } = await import(path));
  }
}
const cookie = sessionCookie();
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });
const failures = [];
let n = 0;

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ ...cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("requestfailed", (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText ?? "failed"}`));

  for (const route of ROUTES) {
    const tag = `${String(n++).padStart(2, "0")}_${route.replaceAll("/", "_")}_${width}`;
    try {
      await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(1_200);
      const overflow = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      const overflowBad = overflow.sw > overflow.cw + 1;
      if (overflowBad || consoleErrors.length > 0 || failedRequests.length > 0) {
        failures.push({ route, width, ...overflow, consoleErrors: [...consoleErrors], failedRequests: [...failedRequests] });
      }
      await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
      console.log(`${overflowBad ? "OVERFLOW" : "ok      "} ${route} @${width} sw=${overflow.sw} cw=${overflow.cw}`);
    } catch (err) {
      failures.push({ route, width, error: String(err).slice(0, 200) });
      console.log(`ERROR   ${route} @${width}: ${String(err).slice(0, 120)}`);
    }
  }
  await ctx.close();
}
await browser.close();

writeFileSync(`${OUT}/failures.json`, JSON.stringify(failures, null, 1));
if (failures.length > 0) {
  console.error(`\nui-visual-check: ${failures.length} failure(s) — details in ${OUT}/failures.json`);
  process.exit(1);
}
console.log(`\nui-visual-check: all routes clean — screenshots in ${OUT}`);
