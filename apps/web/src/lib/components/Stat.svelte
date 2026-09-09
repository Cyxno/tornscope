<script lang="ts">
  import ProvenanceBadge from "./ProvenanceBadge.svelte";
  import ConfidenceBadge from "./ConfidenceBadge.svelte";
  import type { DataConfidenceMetaDto } from "@tornscope/shared";

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
    title,
    confidence,
    confidenceTooltip,
  }: {
    label: string;
    value: string;
    delta?: string | null;
    provenance?: "exact" | "derived" | "estimated";
    tone?: "neutral" | "positive" | "negative" | "accent";
    sub?: string | null;
    /** Optional tooltip clarifying what the figure means. */
    title?: string | null;
    /** Dataset confidence (v0.2): renders a subtle badge beside the label. */
    confidence?: DataConfidenceMetaDto | null;
    confidenceTooltip?: string | undefined;
  } = $props();

  const toneClass = {
    neutral: "text-fg",
    positive: "text-positive",
    negative: "text-negative",
    accent: "text-accent",
  };
</script>

<div class="bg-surface p-5">
  <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
    <span class="min-w-0 text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">{label}</span>
    <span class="inline-flex items-center gap-2">
      <ConfidenceBadge meta={confidence} tooltip={confidenceTooltip} />
      {#if provenance}
        <ProvenanceBadge level={provenance} />
      {/if}
    </span>
  </div>
  <div class="mt-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
    <span class="tnum text-2xl font-semibold {toneClass[tone]}" title={title ?? undefined}>{value}</span>
    {#if delta}
      <span class="text-xs font-medium {delta.startsWith('-') ? 'text-negative' : 'text-positive'}">{delta}</span>
    {/if}
  </div>
  {#if sub}
    <p class="mt-1 text-xs text-fg-muted">{sub}</p>
  {/if}
</div>
