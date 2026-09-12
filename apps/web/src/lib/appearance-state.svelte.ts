import { browser } from "$app/environment";
import {
  DEFAULT_APPEARANCE,
  loadStoredAppearance,
  saveStoredAppearance,
  type Appearance,
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

/** Stable signature of everything that should force a chart repaint. */
export function appearanceSignature(): string {
  return [resolvedThemeDerived, appearance.accent, appearance.palette, appearance.density, appearance.motion].join(":");
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
  applyToDocument();
}

function applyToDocument(): void {
  const de = document.documentElement;
  de.dataset.theme = resolvedThemeDerived;
  de.dataset.accent = appearance.accent;
  de.dataset.density = appearance.density;
  de.dataset.motion = appearance.motion;
  // Browser chrome tint follows the resolved canvas in both themes.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolvedThemeDerived === "dark" ? "#0a0a0c" : "#f4f3ee");
}
