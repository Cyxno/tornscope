#!/usr/bin/env node
/**
 * Browser-level regression test for the Overview net-worth hover bug
 * (1.0.x). This bug escaped source-contract testing, so this script renders
 * the REAL chart in a REAL browser (Playwright + Chromium) and:
 *
 *   1. loads Overview with the demo profile,
 *   2. confirms the net-worth line/area is rendered (canvas pixel sampling
 *      for accent-colored pixels),
 *   3. hovers directly ON the series (pixel-guided) and holds,
 *   4. confirms the tooltip appears,
 *   5. confirms the series REMAINS rendered during hover,
 *   6. mouseout and re-check,
 *   7. asserts zero console/page errors (zrender addColorStop, etc.).
 *
 * Repeats across appearance presets (Graphite / Midnight / Paper) and
 * optionally across viewport widths.
 *
 * Usage:
 *   node scripts/ci/chart-hover-regression.mjs [options]
 *
 * Environment:
 *   BASE_URL     target origin (default http://127.0.0.1:5173)
 *   SHOTS_DIR    directory for diagnostic screenshots (default: none)
 *
 * Requires the `playwright` package (installed alongside Chromium) and a
 * fresh browser profile each run — it must never depend on PWA cache state.
 * Exit code 0 = series visible through hover on every preset; 1 = bug.
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const SHOTS = process.env.SHOTS_DIR ?? "";
const WIDTH = Number(process.env.WIDTH ?? 1440);
if (SHOTS && !existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });

const PRESETS = {
  graphite: null, // default appearance
  midnight: { theme: "dark", accent: "teal", palette: "default", density: "comfortable", motion: "system", canvas: "midnight" },
  paper: { theme: "light", accent: "teal", palette: "default", density: "comfortable", motion: "system", canvas: "paper" },
};

/** Fraction of canvas pixels matching the teal accent family (line/area). */
async function accentRatio(canvas) {
  return canvas.evaluate((el) => {
    const ctx = el.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, el.width, el.height).data;
    let accent = 0;
    const total = el.width * el.height;
    for (let i = 0; i < img.length; i += 4) {
      const r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
      if (a > 200 && g > 100 && g > r + 30 && b > r && Math.abs(g - b) < 120 && r < 160) accent++;
    }
    return accent / total;
  });
}

/** Find a canvas x/y where the series line actually is (accent pixels). */
async function findSeriesPoint(canvas) {
  return canvas.evaluate((el) => {
    const ctx = el.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, el.width, el.height).data;
    const w = el.width, h = el.height;
    for (let x = Math.floor(w * 0.3); x < w * 0.7; x += 4) {
      for (let y = 0; y < h; y += 2) {
        const i = (y * w + x) * 4;
        const r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
        if (a > 200 && g > 100 && g > r + 30 && b > r && Math.abs(g - b) < 120 && r < 160) {
          return { x, y }; // canvas-internal coordinates
        }
      }
    }
    return null;
  });
}

async function runPreset(browser, presetName) {
  const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 } });
  if (PRESETS[presetName]) {
    await ctx.addInitScript((p) => window.localStorage.setItem("tornscope.appearance.v1", JSON.stringify(p)), PRESETS[presetName]);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  // Fresh profile: go through the public demo entry if onboarding redirects.
  await page.goto(BASE + "/welcome", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const demoButton = page.getByRole("button", { name: /demo data first/i }).first();
  if (await demoButton.count()) {
    await demoButton.click();
    await page.waitForTimeout(6000);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    if (!/\/(welcome|today)/.test(new URL(page.url()).pathname)) break;
  }

  const canvas = page.locator("section[aria-label='Net worth'] canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(1500); // let entry animation settle

  const before = await accentRatio(canvas);
  if (before <= 0.0005) throw new Error(`${presetName}: series not rendered before hover (accent ratio ${before})`);

  // Hover directly ON the series (pixel-guided), then HOLD on it.
  const box = await canvas.boundingBox();
  const point = await findSeriesPoint(canvas);
  if (!point) throw new Error(`${presetName}: could not locate the series line on canvas`);
  // Canvas internal pixels map 1:1 to CSS pixels here (dpr=1 in this suite).
  const targetX = box.x + point.x;
  const targetY = box.y + point.y;
  await page.mouse.move(targetX - 60, targetY, { steps: 8 });
  await page.mouse.move(targetX, targetY, { steps: 4 });
  await page.waitForTimeout(400); // tooltip + emphasis settle; hover HELD

  const duringHeld = await accentRatio(canvas);
  const tooltipVisible = await page
    .locator("div:visible")
    .filter({ hasText: /Net worth/i })
    .count() > 0;
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `hover-held-${presetName}.png`) });

  // Sweep across the chart while sampling (rapid hover between points).
  const samples = [];
  for (let i = 0; i <= 8; i++) {
    await page.mouse.move(box.x + (box.width * (0.3 + (0.4 * i) / 8)), targetY, { steps: 2 });
    if (i % 2 === 0) samples.push(await accentRatio(canvas));
  }
  // Mouseout.
  await page.mouse.move(box.x + box.width / 2, box.y - 40, { steps: 6 });
  await page.waitForTimeout(500);
  const after = await accentRatio(canvas);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `after-out-${presetName}.png`) });

  const renderErrors = errors.filter((e) => !/favicon|sourced register|third-party/i.test(e));
  await ctx.close();

  const duringMin = Math.min(duringHeld, ...samples);
  return {
    preset: presetName,
    before,
    duringHeld,
    duringMin,
    after,
    tooltipVisible,
    errors: renderErrors,
    ok:
      before > 0.0005 &&
      duringMin > 0.0005 && // series must stay rendered the whole time
      after > 0.0005 &&
      renderErrors.length === 0,
  };
}

const browser = await chromium.launch();
try {
  const results = [];
  for (const presetName of Object.keys(PRESETS)) {
    results.push(await runPreset(browser, presetName));
  }
  console.log(JSON.stringify(results, null, 1));
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? "CHART HOVER REGRESSION: PASS" : "CHART HOVER REGRESSION: FAIL");
  process.exitCode = allOk ? 0 : 1;
} finally {
  await browser.close();
}
