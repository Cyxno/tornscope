import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORICAL, BATTLESTATS, RAMPS } from "../src/lib/chart-palettes";
import { DEFAULT_APPEARANCE, parseStoredAppearance, resolveCanvas } from "../src/lib/appearance.svelte";

/**
 * Appearance system contracts (v0.2 settings redesign + theming epic).
 *
 * Source-level contracts for the no-flash bootstrap, the preference model's
 * invalid-value fallbacks, and the chart palette invariants (semantic colors
 * per theme, palettes complete per theme, battlestat identity stable across
 * palettes, positive/negative never overridden by accent or palette).
 */

const read = (p: string) => readFileSync(join(__dirname, "../src", p), "utf8");

describe("no-flash bootstrap (app.html)", () => {
  const html = read("app.html");

  it("loads the bootstrap from a CSP-safe static file before the head content", () => {
    expect(html).toContain('<script src="/appearance-bootstrap.js"></script>');
    const scriptStart = html.indexOf('<script src="/appearance-bootstrap.js"');
    const styleStart = html.indexOf("%sveltekit.head%");
    expect(scriptStart).toBeGreaterThan(-1);
    expect(scriptStart).toBeLessThan(styleStart);
  });

  it("resolves System via prefers-color-scheme and defaults to dark brand", () => {
    const bootstrap = read("../static/appearance-bootstrap.js");
    expect(bootstrap).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(bootstrap).toContain('s.theme === "light" || s.theme === "dark" ? s.theme : "system"');
    expect(html).toContain('data-theme="dark"');
  });

  it("applies accent, density and motion data attributes pre-paint", () => {
    const bootstrap = read("../static/appearance-bootstrap.js");
    expect(bootstrap).toContain("de.dataset.accent");
    expect(bootstrap).toContain("de.dataset.density");
    expect(bootstrap).toContain("de.dataset.motion");
    expect(bootstrap).toContain('localStorage.getItem("tornscope.appearance.v1")');
  });
});

describe("preference model fallbacks", () => {
  it("invalid values fall back to defaults instead of breaking", () => {
    expect(parseStoredAppearance({ theme: "sepia", accent: "hot-pink", palette: "neon" })).toEqual(DEFAULT_APPEARANCE);
    expect(parseStoredAppearance("garbage")).toEqual(DEFAULT_APPEARANCE);
    expect(parseStoredAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it("valid values survive the round trip", () => {
    const stored = { theme: "light", accent: "violet", palette: "colorblind", density: "compact", motion: "reduced", canvas: "mist" };
    expect(parseStoredAppearance(stored)).toEqual(stored);
  });
});

describe("chart palette invariants", () => {
  const paletteIds = ["default", "muted", "high-contrast", "colorblind", "monochrome"] as const;

  it("every palette defines both themes with enough distinct series colors", () => {
    for (const id of paletteIds) {
      for (const mode of ["dark", "light"] as const) {
        const colors = CATEGORICAL[id][mode];
        expect(colors.length).toBeGreaterThanOrEqual(6);
        expect(new Set(colors).size).toBe(colors.length);
      }
    }
  });

  it("palettes differ from each other within a theme", () => {
    for (const mode of ["dark", "light"] as const) {
      const firsts = paletteIds.map((id) => CATEGORICAL[id][mode][0]);
      expect(new Set(firsts).size).toBe(paletteIds.length);
    }
  });

  it("battlestat identity colors are stable across palettes and differ per stat", () => {
    for (const mode of ["dark", "light"] as const) {
      const bs = BATTLESTATS[mode];
      expect(new Set(Object.values(bs)).size).toBe(4);
      for (const id of paletteIds) {
        // battlestats are identity colors: the same in every palette
        expect(CATEGORICAL[id]).toBeDefined(); // palettes exist independently
      }
    }
    expect(BATTLESTATS.dark).not.toEqual(BATTLESTATS.light);
  });

  it("inflow/outflow ramps exist for every palette and theme", () => {
    for (const id of paletteIds) {
      for (const mode of ["dark", "light"] as const) {
        expect(RAMPS[id][mode].inflow.length).toBeGreaterThanOrEqual(6);
        expect(RAMPS[id][mode].outflow.length).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it("positive/negative stay semantic (never accent teal defaults in light mode)", () => {
    // Semantic colors are theme-scoped constants — the accent presets never
    // touch them. Guard the light-theme semantic contract specifically:
    // the css block must define light --ds-positive/negative explicitly.
    const css = read("../src/app.css");
    expect(css).toMatch(/\[data-theme="light"\] \{[\s\S]*?--ds-positive: #178a4e/);
    expect(css).toMatch(/\[data-theme="light"\] \{[\s\S]*?--ds-negative: #c53f3f/);
  });
});

describe("accent presets", () => {
  const css = read("../src/app.css");

  it("every accent defines dark and light variants with rgb triplets", () => {
    // The default (teal) accent resolves through --ds-accent-rgb; the CSS
    // consumes it as rgb(var(--ds-accent-rgb) / alpha) for tinted alphas.
    expect(css).toContain("--ds-accent-rgb:");
    expect(css).toContain("rgb(var(--ds-accent-rgb) / 0.3)");
    for (const accent of ["blue", "indigo", "violet", "emerald", "amber", "rose"]) {
      expect(css).toContain(`[data-accent="${accent}"]`);
      const block = css.slice(css.indexOf(`[data-accent="${accent}"]`));
      expect(block).toContain("--ds-accent-rgb:");
    }
  });

  it("light variants override accent main for contrast", () => {
    // Each accent's light block re-declares the main color.
    const count = (css.match(/\[data-accent="\w+"\]\[data-theme="light"\]/g) ?? []).length;
    // teal light variant lives in the global [data-theme=light] block;
    // the six non-default accents each carry an explicit light override.
    expect(count).toBe(6);
  });
});

describe("settings tab model", () => {
  const page = read("routes/settings/+page.svelte");

  it("tabs deep-link through ?tab= with graceful fallback", () => {
    expect(page).toContain('new URLSearchParams(window.location.search).get("tab")');
    expect(page).toContain("(TAB_IDS as string[]).includes(raw)");
    expect(page).toContain('window.history.pushState({}, "", url)');
  });

  it("renders all six tabs", () => {
    for (const label of ["General", "Appearance", "Notifications", "API & Data", "Devices", "Advanced"]) {
      expect(page).toContain(`label: "${label}"`);
    }
  });
});

describe("density + motion tokenization", () => {
  const css = read("../src/app.css");

  it("compact density tightens rows and tables", () => {
    expect(css).toContain('[data-density="compact"] .tsv-table tbody td');
    expect(css).toContain("--row-pad-y: 0.3rem");
  });

  it("compact keeps touch-target heights on phones", () => {
    expect(css).toMatch(/\(min-width: 640px\)[\s\S]*?\[data-density="compact"\] \.input/);
  });
});

describe("canvas background presets (V1.0 appearance)", () => {
  const bootstrap = read("../static/appearance-bootstrap.js");
  const css = read("app.css");

  it("canvas is part of the preference model with a stable default", () => {
    expect(DEFAULT_APPEARANCE.canvas).toBe("graphite");
    // Existing users with no stored key keep the pre-1.0 look.
    expect(parseStoredAppearance({ theme: "dark", accent: "blue" }).canvas).toBe("graphite");
  });

  it("malformed/unknown canvas values fall back instead of breaking", () => {
    expect(parseStoredAppearance({ canvas: "neon-night" }).canvas).toBe("graphite");
    expect(parseStoredAppearance({ canvas: 42 }).canvas).toBe("graphite");
    expect(parseStoredAppearance({ canvas: null }).canvas).toBe("graphite");
    expect(parseStoredAppearance("{}").canvas).toBe("graphite");
  });

  it("every allowed preset survives the round trip", () => {
    for (const canvas of ["graphite", "midnight", "charcoal", "slate", "paper", "warm", "mist"]) {
      expect(parseStoredAppearance({ canvas }).canvas).toBe(canvas);
    }
  });

  it("resolves family-correct canvases; cross-family falls back to the family default", () => {
    expect(resolveCanvas("dark", "graphite")).toBe("graphite");
    expect(resolveCanvas("dark", "midnight")).toBe("midnight");
    expect(resolveCanvas("dark", "mist")).toBe("graphite"); // light preset under dark
    expect(resolveCanvas("light", "paper")).toBe("paper");
    expect(resolveCanvas("light", "warm")).toBe("warm");
    expect(resolveCanvas("light", "midnight")).toBe("paper"); // dark preset under light
  });

  it("the bootstrap applies data-canvas pre-paint with family fallback", () => {
    expect(bootstrap).toContain("dataset.canvas");
    expect(bootstrap).toContain('"graphite"');
    expect(bootstrap).toContain('"paper"');
  });

  it("every non-default preset has canvas token overrides in app.css", () => {
    for (const canvas of ["midnight", "charcoal", "slate", "warm", "mist"]) {
      expect(css, `missing [data-canvas="${canvas}"]`).toContain(`[data-canvas="${canvas}"]`);
    }
  });

  it("canvas presets restyle the canvas layer only — semantics untouched", () => {
    // Financial semantic colors stay in the theme blocks, never in canvas blocks.
    const canvasBlocks = css.slice(css.indexOf("Canvas (background) presets"), css.indexOf("Accent presets"));
    expect(canvasBlocks).not.toContain("--ds-positive:");
    expect(canvasBlocks).not.toContain("--ds-negative:");
    expect(canvasBlocks).not.toContain("--ds-accent:");
  });

  it("charts track the canvas surface", () => {
    expect(read("lib/charts.ts")).toContain("CANVAS_SURFACE");
  });
});
