<script lang="ts">
  import ProvenanceBadge from "./ProvenanceBadge.svelte";

  /**
   * A single figure inside a hairline-divided stat strip.
   * Numbers lead; labels stay quiet. Not a card — a cell.
   */
  let {
    label,
    value,
    delta,
    provenance,
    tone = "neutral",
    sub,
  }: {
    label: string;
    value: string;
    delta?: string | null;
    provenance?: "exact" | "derived" | "estimated";
    tone?: "neutral" | "positive" | "negative" | "accent";
    sub?: string | null;
  } = $props();

  const toneClass = {
    neutral: "text-fg",
    positive: "text-positive",
    negative: "text-negative",
    accent: "text-accent",
  };
</script>

<div class="bg-surface p-5">
  <div class="flex items-center justify-between gap-2">
    <span class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">{label}</span>
    {#if provenance}
      <ProvenanceBadge level={provenance} />
    {/if}
  </div>
  <div class="mt-2.5 flex items-baseline gap-2.5">
    <span class="tnum text-2xl font-semibold {toneClass[tone]}">{value}</span>
    {#if delta}
      <span class="text-xs font-medium {delta.startsWith('-') ? 'text-negative' : 'text-positive'}">{delta}</span>
    {/if}
  </div>
  {#if sub}
    <p class="mt-1 text-xs text-fg-muted">{sub}</p>
  {/if}
</div>
