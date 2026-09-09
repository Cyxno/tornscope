<script lang="ts">
  import ProvenanceBadge from "./ProvenanceBadge.svelte";
  import ConfidenceBadge from "./ConfidenceBadge.svelte";
  import type { DataConfidenceMetaDto } from "@tornscope/shared";

  /**
   * A single KPI inside a hairline-divided stat strip. Numbers lead, labels
   * stay quiet. A confirmed zero renders "0"; an unavailable figure renders
   * "—" (the caller's formatting decides — this component only presents).
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
    loading = false,
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
    /** Reserve stable space while the figure is being fetched. */
    loading?: boolean;
  } = $props();

  const toneClass = {
    neutral: "text-fg",
    positive: "text-positive",
    negative: "text-negative",
    accent: "text-accent",
  };
</script>

<div class="bg-surface p-4 sm:p-5">
  <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
    <span class="min-w-0 text-[11px] font-medium text-fg-faint" title={title ?? undefined}>{label}</span>
    <span class="inline-flex items-center gap-1.5">
      <ConfidenceBadge meta={confidence} tooltip={confidenceTooltip} />
      {#if provenance}
        <ProvenanceBadge level={provenance} />
      {/if}
    </span>
  </div>
  {#if loading}
    <div class="skeleton mt-2.5 h-7 w-24"></div>
  {:else}
    <div class="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
      <span class="tnum text-[22px] font-semibold leading-tight {toneClass[tone]}" title={title ?? undefined}>{value}</span>
      {#if delta}
        <span class="tnum text-xs font-medium {delta.startsWith('-') ? 'text-negative' : 'text-positive'}">{delta}</span>
      {/if}
    </div>
  {/if}
  {#if sub}
    <p class="mt-1 text-[11.5px] leading-relaxed text-fg-muted" title={title ?? undefined}>{sub}</p>
  {/if}
</div>
