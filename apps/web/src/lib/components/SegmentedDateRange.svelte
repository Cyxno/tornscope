<script lang="ts">
  import { DATE_PRESETS, setPreset, setCustomRange, dateRange } from "$lib/state.svelte";

  /**
   * Segmented control for the global date range.
   * Active segment is inverted (light on dark) for a crisp premium feel.
   */
  let showCustom = $state(false);
  let customFrom = $state("");
  let customTo = $state("");

  function applyCustom() {
    const from = customFrom ? Math.floor(new Date(`${customFrom}T00:00:00Z`).getTime() / 1000) : undefined;
    const to = customTo ? Math.floor(new Date(`${customTo}T23:59:59Z`).getTime() / 1000) : undefined;
    if (from || to) setCustomRange(from ?? 0, to ?? Math.floor(Date.now() / 1000));
  }
</script>

<div class="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full border border-border bg-surface p-1">
  {#each DATE_PRESETS as preset (preset.value)}
    <button
      class="rounded-full px-3 py-1.5 text-xs font-medium transition-all {dateRange.preset === preset.value && !showCustom
        ? 'bg-fg font-semibold text-bg'
        : 'text-fg-muted hover:text-fg'}"
      onclick={() => {
        showCustom = false;
        setPreset(preset.value);
      }}
    >
      {preset.label}
    </button>
  {/each}
  <button
    class="rounded-full px-3 py-1.5 text-xs font-medium transition-all {dateRange.preset === 'custom'
      ? 'bg-fg font-semibold text-bg'
      : 'text-fg-muted hover:text-fg'}"
    onclick={() => (showCustom = !showCustom)}
  >
    Custom
  </button>
</div>

{#if showCustom}
  <div class="mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-border bg-bg-raise p-3">
    <label class="text-xs text-fg-muted">
      From
      <input type="date" bind:value={customFrom} class="ml-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg" />
    </label>
    <label class="text-xs text-fg-muted">
      To
      <input type="date" bind:value={customTo} class="ml-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg" />
    </label>
    <button class="rounded-lg bg-accent-strong px-3.5 py-1.5 text-xs font-semibold text-bg transition-colors hover:bg-accent" onclick={applyCustom}>
      Apply range
    </button>
  </div>
{/if}
