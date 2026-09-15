<script lang="ts">
  import { DATE_PRESETS, setPreset, setCustomRange, dateRange, rememberRouteRange, routeRange, defaultPreset } from "$lib/state.svelte";
  import { onMount } from "svelte";

  /**
   * Segmented control for the global date range. Active segment is inverted
   * (light on dark); Custom unfolds an inline two-date form.
   *
   * Semantics (documented, not implied): every preset is a whole number of
   * TORN CALENDAR DAYS (UTC) ending with the current one — "1D" is the
   * current Torn day, still in progress. Tooltips carry that meaning so the
   * control never has to be guessed at; the Today page, by contrast, uses
   * the profile timezone (clarified there and in Settings).
   */
  const PRESET_HINTS: Record<string, string> = {
    "1d": "Current Torn day (UTC) — in progress",
    "7d": "Last 7 Torn days (UTC), today included",
    "14d": "Last 14 Torn days (UTC), today included",
    "30d": "Last 30 Torn days (UTC), today included",
    "90d": "Last 90 Torn days (UTC), today included",
    this_month: "The current calendar month (UTC), in progress",
    this_year: "The current calendar year (UTC), in progress",
    all: "Everything on record",
  };

  // Per-route memory (V1.0 QOL): a route reopens with its own last preset;
  // the Settings default still governs first-ever visits.
  onMount(() => {
    const remembered = routeRange(window.location.pathname);
    if (remembered && dateRange.preset !== remembered) setPreset(remembered);
  });

  function selectPreset(value: (typeof DATE_PRESETS)[number]["value"]) {
    showCustom = false;
    setPreset(value);
    rememberRouteRange(window.location.pathname, value);
  }

  let showCustom = $state(false);
  let customFrom = $state("");
  let customTo = $state("");

  function applyCustom() {
    const from = customFrom ? Math.floor(new Date(`${customFrom}T00:00:00Z`).getTime() / 1000) : undefined;
    const to = customTo ? Math.floor(new Date(`${customTo}T23:59:59Z`).getTime() / 1000) : undefined;
    if (!from && !to) return;
    // A one-sided entry means "from the beginning of recorded time" or
    // "up to that day" — 0 is the honest epoch bound, never a fake date.
    if (from && to) {
      setCustomRange(from, to);
    } else if (from) {
      setCustomRange(from, Math.floor(Date.now() / 1000));
    } else if (to) {
      setCustomRange(0, to);
    }
  }
</script>

<div class="inline-flex max-w-full flex-wrap items-center gap-1">
  <div class="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full border border-border bg-surface p-1">
    {#each DATE_PRESETS as preset (preset.value)}
      <button
        class="rounded-full px-3 py-1 text-xs font-medium transition-all {dateRange.preset === preset.value && !showCustom
          ? 'bg-fg font-semibold text-bg'
          : 'text-fg-muted hover:text-fg'}"
        title={PRESET_HINTS[preset.value] ?? preset.label}
        onclick={() => selectPreset(preset.value)}
      >
        {preset.label}
      </button>
    {/each}
    <button
      class="rounded-full px-3 py-1 text-xs font-medium transition-all {dateRange.preset === 'custom' || showCustom
        ? 'bg-fg font-semibold text-bg'
        : 'text-fg-muted hover:text-fg'}"
      title="Pick exact dates — whole Torn calendar days (UTC)"
      onclick={() => (showCustom = !showCustom)}
      aria-expanded={showCustom}
    >
      Custom
    </button>
  </div>
</div>

{#if showCustom}
  <div class="rise-in mt-3 flex flex-wrap items-center gap-2.5 rounded-tile border border-border bg-bg-raise p-3">
    <label class="flex items-center gap-1.5 text-xs text-fg-muted">
      From
      <input type="date" bind:value={customFrom} class="input !h-8 w-36 [color-scheme:dark]" />
    </label>
    <label class="flex items-center gap-1.5 text-xs text-fg-muted">
      To
      <input type="date" bind:value={customTo} class="input !h-8 w-36 [color-scheme:dark]" />
    </label>
    <button class="btn btn-primary btn-sm" onclick={applyCustom}>Apply range</button>
    <span class="text-[11px] text-fg-faint">Dates are Torn calendar days (UTC) — the same day boundaries analytics use.</span>
  </div>
{/if}
