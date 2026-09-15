<script lang="ts">
  import { CANVAS_DARK, CANVAS_LIGHT, resolveCanvas, type CanvasPreference, type ChartPalette } from "$lib/appearance.svelte";
  import { ACCENTS, PALETTES, type AccentPreference, type DensityPreference, type MotionPreference, type ThemePreference } from "$lib/appearance.svelte";
  import { appearance, applyAppearance, resolvedTheme } from "$lib/appearance-state.svelte";
  import type { ResolvedTheme } from "$lib/appearance.svelte";
  import { accentPreviewFor, palettePreviewFor } from "$lib/charts";

  /**
   * Appearance tab — live personalization. Every control applies
   * immediately (preferences persist to the browser; see
   * lib/appearance.svelte.ts for the persistence model).
   */

  const THEMES: Array<{ value: ThemePreference; label: string; hint: string }> = [
    { value: "system", label: "System", hint: "Follow your OS setting" },
    { value: "light", label: "Light", hint: "Warm paper canvas" },
    { value: "dark", label: "Dark", hint: "Graphite Ledger" },
  ];

  const ACCENT_LABELS: Record<AccentPreference, string> = {
    teal: "Teal",
    blue: "Blue",
    indigo: "Indigo",
    violet: "Violet",
    emerald: "Emerald",
    amber: "Amber",
    rose: "Rose",
  };

  const PALETTE_LABELS: Record<ChartPalette, string> = {
    default: "Default",
    muted: "Muted",
    "high-contrast": "High contrast",
    colorblind: "Colorblind-friendly",
    monochrome: "Monochrome",
  };
  const PALETTE_HINTS: Record<ChartPalette, string> = {
    default: "Balanced, product-native",
    muted: "Lower saturation, softer hierarchy",
    "high-contrast": "Strongest series separation",
    colorblind: "Distinguishable under common color-vision deficiencies",
    monochrome: "Luminance ramp — single-hue discipline",
  };

  const DENSITIES: Array<{ value: DensityPreference; label: string; hint: string }> = [
    { value: "comfortable", label: "Comfortable", hint: "Standard row height" },
    { value: "compact", label: "Compact", hint: "Tighter rows and tables" },
  ];

  const MOTIONS: Array<{ value: MotionPreference; label: string; hint: string }> = [
    { value: "system", label: "System", hint: "Follow your OS setting" },
    { value: "reduced", label: "Reduced", hint: "No animation" },
    { value: "full", label: "Full", hint: "All motion enabled" },
  ];

  const CANVAS_META: Record<CanvasPreference, { label: string; hint: string; swatch: string }> = {
    graphite: { label: "Graphite", hint: "Current dark — warm graphite", swatch: "#0a0a0c" },
    midnight: { label: "Midnight", hint: "Very dark blue-gray", swatch: "#0b0e16" },
    charcoal: { label: "Charcoal", hint: "Softer neutral dark", swatch: "#141416" },
    slate: { label: "Slate", hint: "Cooler dark gray", swatch: "#131820" },
    paper: { label: "Paper", hint: "Current light — warm paper", swatch: "#f4f3ee" },
    warm: { label: "Warm Paper", hint: "Subtle warm off-white", swatch: "#f7f1e6" },
    mist: { label: "Cool Mist", hint: "Subtle cool off-white", swatch: "#edf1f2" },
  };
  const isDark = () => resolvedTheme() === "dark";
  const canvasOptions = () => (isDark() ? CANVAS_DARK : CANVAS_LIGHT);
  const currentCanvas = () => resolveCanvas(resolvedTheme(), appearance.canvas);

  function resetAppearance(): void {
    applyAppearance({ theme: "system", accent: "teal", palette: "default", density: "comfortable", motion: "system" });
  }
</script>

<div class="space-y-7">
  <!-- Theme -->
  <section aria-labelledby="appearance-theme" class="space-y-3">
    <h2 id="appearance-theme" class="section-label">Theme</h2>
    <div class="flex flex-wrap gap-2" role="group" aria-label="Theme">
      {#each THEMES as t (t.value)}
        <button
          class="flex min-w-[104px] flex-col items-start gap-2 rounded-tile border px-3.5 py-3 text-left transition-colors {appearance.theme === t.value
            ? 'border-accent bg-accent/5'
            : 'border-border bg-surface hover:border-border-strong'}"
          aria-pressed={appearance.theme === t.value}
          onclick={() => applyAppearance({ theme: t.value })}
        >
          <span class="flex gap-1" aria-hidden="true">
            <span class="h-4 w-4 rounded-full border border-border" style={`background: ${t.value === "light" ? "#f4f3ee" : "#0a0a0c"}`}></span>
            <span class="h-4 w-4 rounded-full border border-border" style={`background: ${t.value === "light" ? "#fbfaf6" : "#141417"}`}></span>
            <span class="h-4 w-4 rounded-full border border-border" style={`background: ${t.value === "light" ? "#0d9488" : "#2dd4bf"}`}></span>
          </span>
          <span class="text-[13px] font-medium text-fg">{t.label}</span>
          <span class="text-[11px] leading-snug text-fg-faint">{t.hint}</span>
        </button>
      {/each}
    </div>
  </section>

  <!-- Background preset: family-scoped to the resolved theme. -->
  <section aria-labelledby="appearance-canvas" class="space-y-3">
    <h2 id="appearance-canvas" class="section-label">Background</h2>
    <div class="flex flex-wrap gap-2" role="group" aria-label="Background preset">
      {#each canvasOptions() as canvas (canvas)}
        <button
          class="flex min-w-[108px] flex-col items-start gap-2 rounded-tile border px-3.5 py-3 text-left transition-colors {currentCanvas() === canvas
            ? 'border-accent bg-accent/5'
            : 'border-border bg-surface hover:border-border-strong'}"
          aria-pressed={currentCanvas() === canvas}
          onclick={() => applyAppearance({ canvas })}
        >
          <span class="flex items-center gap-2" aria-hidden="true">
            <span class="h-4 w-4 rounded-full border border-border" style={`background: ${CANVAS_META[canvas].swatch}`}></span>
            <span class="text-[13px] font-medium text-fg">{CANVAS_META[canvas].label}</span>
          </span>
          <span class="text-[11px] leading-snug text-fg-faint">{CANVAS_META[canvas].hint}</span>
        </button>
      {/each}
    </div>
    <p class="text-[11px] leading-relaxed text-fg-faint">
      Background character for {isDark() ? "dark" : "light"} mode — typography and financial colors are untouched.
    </p>
  </section>

  <!-- Accent -->
  <section aria-labelledby="appearance-accent" class="space-y-3">
    <h2 id="appearance-accent" class="section-label">Accent</h2>
    <div class="flex flex-wrap gap-2" role="group" aria-label="Accent color">
      {#each ACCENTS as id (id)}
        <button
          class="flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors {appearance.accent === id
            ? 'border-accent bg-accent/10 font-semibold text-fg'
            : 'border-border bg-surface text-fg-muted hover:border-border-strong'}"
          aria-pressed={appearance.accent === id}
          onclick={() => applyAppearance({ accent: id })}
        >
          <span class="h-3 w-3 rounded-full border border-border" style={`background: ${accentPreviewFor(id, resolvedTheme())}`}></span>
          {ACCENT_LABELS[id]}
        </button>
      {/each}
    </div>
    <p class="text-[11px] leading-relaxed text-fg-faint">
      Accent colors highlight interactive elements only — gains, losses, warnings and danger keep their own semantic colors.
    </p>
  </section>

  <!-- Chart palette -->
  <section aria-labelledby="appearance-palette" class="space-y-3">
    <h2 id="appearance-palette" class="section-label">Chart palette</h2>
    <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {#each PALETTES as id (id)}
        {@const colors = palettePreviewFor(id, resolvedTheme())}
        <button
          class="flex flex-col gap-2 rounded-tile border px-3.5 py-3 text-left transition-colors {appearance.palette === id
            ? 'border-accent bg-accent/5'
            : 'border-border bg-surface hover:border-border-strong'}"
          aria-pressed={appearance.palette === id}
          onclick={() => applyAppearance({ palette: id })}
        >
          <span class="text-[13px] font-medium text-fg">{PALETTE_LABELS[id]}</span>
          <span class="flex items-end gap-1" aria-hidden="true">
            {#each colors as color, i (i)}
              <span class="w-3 rounded-sm" style={`height: ${10 + ((i * 7) % 14)}px; background: ${color}`}></span>
            {/each}
          </span>
          <span class="text-[11px] leading-snug text-fg-faint">{PALETTE_HINTS[id]}</span>
        </button>
      {/each}
    </div>
  </section>

  <!-- Density -->
  <section aria-labelledby="appearance-density" class="space-y-3">
    <h2 id="appearance-density" class="section-label">Interface density</h2>
    <div class="flex flex-wrap gap-2" role="group" aria-label="Interface density">
      {#each DENSITIES as d (d.value)}
        <button
          class="flex min-w-[140px] flex-col items-start gap-1.5 rounded-tile border px-3.5 py-3 text-left transition-colors {appearance.density === d.value
            ? 'border-accent bg-accent/5'
            : 'border-border bg-surface hover:border-border-strong'}"
          aria-pressed={appearance.density === d.value}
          onclick={() => applyAppearance({ density: d.value })}
        >
          <span class="text-[13px] font-medium text-fg">{d.label}</span>
          <span class="text-[11px] leading-snug text-fg-faint">{d.hint}</span>
          <span class="mt-1 w-full space-y-1" aria-hidden="true">
            <span class="block h-2 rounded-sm bg-surface-3"></span>
            <span class="block h-2 rounded-sm bg-surface-2 {d.value === 'compact' ? 'mt-0.5' : 'mt-1'}"></span>
          </span>
        </button>
      {/each}
    </div>
  </section>

  <!-- Motion -->
  <section aria-labelledby="appearance-motion" class="space-y-3">
    <h2 id="appearance-motion" class="section-label">Motion</h2>
    <div class="flex flex-wrap gap-2" role="group" aria-label="Motion">
      {#each MOTIONS as m (m.value)}
        <button
          class="flex min-w-[128px] flex-col items-start gap-1 rounded-tile border px-3.5 py-3 text-left transition-colors {appearance.motion === m.value
            ? 'border-accent bg-accent/5'
            : 'border-border bg-surface hover:border-border-strong'}"
          aria-pressed={appearance.motion === m.value}
          onclick={() => applyAppearance({ motion: m.value })}
        >
          <span class="text-[13px] font-medium text-fg">{m.label}</span>
          <span class="text-[11px] leading-snug text-fg-faint">{m.hint}</span>
        </button>
      {/each}
    </div>
    <p class="text-[11px] text-fg-faint">
      Currently rendering in <span class="font-medium">{resolvedTheme() === "light" ? "Light" : "Dark"}</span>
      {#if appearance.theme === "system"}· following your system preference{/if}.
    </p>
  </section>

  <div class="flex items-center justify-between gap-4 border-t border-border pt-4">
    <p class="text-[11px] text-fg-faint">Preferences are stored in this browser and apply before the page paints.</p>
    <button class="btn btn-sm" onclick={resetAppearance}>Reset appearance</button>
  </div>
</div>
