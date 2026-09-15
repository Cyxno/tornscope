import { browser } from "$app/environment";
import {
  DEFAULT_APPEARANCE,
  loadStoredAppearance,
  saveStoredAppearance,
  resolveCanvas,
  type Appearance,
  type CanvasPreference,
  type ResolvedTheme,
} from "./appearance.svelte";

/**
 * Reactive appearance state (Svelte 5 runes module).
 *
 * The bootstrap script in app.html already applied the stored preferences to
 * <html> data-attributes before first paint; this module mirrors that state
 * reactively, applies changes live, and follows the OS theme while
 * Theme = "system". Reading `resolvedTheme` / `prefersReducedMotion` inside
 * a $derived registers reactivity for anything that must re-render on
 * appearance changes (e.g. chart options).
 */

const STORAGE_KEY = "tornscope.appearance.v1";

export const appearance: Appearance = $state(
  browser ? loadStoredAppearance(window.localStorage) : { ...DEFAULT_APPEARANCE }
);

// System media state kept in $state so derived values re-run when the OS
// flips theme/reduced-motion while the app is open.
let systemDarkMatches = $state(false);
let systemReducedMatches = $state(false);

const resolvedThemeDerived = $derived(
  appearance.theme === "system" ? (systemDarkMatches ? "dark" : "light") : appearance.theme
);

/** Resolved theme (Svelte 5: export functions, not derived bindings). */
export function resolvedTheme(): ResolvedTheme {
  return resolvedThemeDerived;
}

const reducedMotionDerived = $derived(
  appearance.motion === "reduced" ? true : appearance.motion === "full" ? false : systemReducedMatches
);

/** The canvas actually rendered for the resolved theme. */
export function resolvedCanvas(): CanvasPreference {
  return resolveCanvas(resolvedThemeDerived, appearance.canvas);
}

/** Stable signature of everything that should force a chart repaint. */
export function appearanceSignature(): string {
  return [resolvedThemeDerived, appearance.accent, appearance.palette, appearance.density, appearance.motion, appearance.canvas].join(":");
}

export function prefersReducedMotion(): boolean {
  return reducedMotionDerived;
}

/** Apply preferences to <html> and persist. Called by the settings UI. */
export function applyAppearance(next: Partial<Appearance>): void {
  Object.assign(appearance, next);
  if (browser) saveStoredAppearance(window.localStorage, appearance);
  applyToDocument();
}

let initialized = false;
/** Client-side sync with the pre-paint bootstrap + OS theme listeners. */
export function initAppearance(): void {
  if (!browser || initialized) return;
  initialized = true;
  systemDarkMatches = window.matchMedia("(prefers-color-scheme: dark)").matches;
  systemReducedMatches = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    systemDarkMatches = e.matches;
    applyToDocument();
  });
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => {
    systemReducedMatches = e.matches;
  });
  // Other tabs of the same browser update this tab live as well.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    Object.assign(appearance, loadStoredAppearance(window.localStorage));
    applyToDocument();
  });
  applyToDocument();
}

/** Browser-chrome tint per resolved canvas (keep in sync with app.css). */
const CANVAS_CHROME: Record<string, { dark: string; light: string }> = {
  graphite: { dark: "#0a0a0c", light: "#f4f3ee" },
  midnight: { dark: "#07090f", light: "#f4f3ee" },
  charcoal: { dark: "#0f0f10", light: "#f4f3ee" },
  slate: { dark: "#0e1216", light: "#f4f3ee" },
  paper: { dark: "#0a0a0c", light: "#f4f3ee" },
  warm: { dark: "#0a0a0c", light: "#f7f1e6" },
  mist: { dark: "#0a0a0c", light: "#edf1f2" },
};

function applyToDocument(): void {
  const de = document.documentElement;
  const theme = resolvedThemeDerived;
  const canvas = resolveCanvas(theme, appearance.canvas);
  de.dataset.theme = theme;
  de.dataset.accent = appearance.accent;
  de.dataset.density = appearance.density;
  de.dataset.motion = appearance.motion;
  de.dataset.canvas = canvas;
  // Browser chrome tint follows the resolved canvas in both themes.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const tint = CANVAS_CHROME[canvas] ?? CANVAS_CHROME.graphite;
    meta.setAttribute("content", theme === "dark" ? tint.dark : tint.light);
  }
}
