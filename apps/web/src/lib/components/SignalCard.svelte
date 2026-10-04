<script lang="ts">
  import type { DecisionSignalDto } from "@tornscope/shared";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";

  /**
   * Decision Intelligence signal — small, quiet, evidence-first. Category
   * label + title + one-line summary + metric comparison + confidence/
   * provenance + optional action. No neon badges, no giant cards.
   */
  let {
    signal,
    isNew = false,
    compact = false,
  }: { signal: DecisionSignalDto; isNew?: boolean; compact?: boolean } = $props();

  const categoryStyle: Record<string, string> = {
    OPPORTUNITY: "text-positive",
    RISK: "text-negative",
    INEFFICIENCY: "text-warning",
    TREND: "text-accent",
    MILESTONE: "text-info",
    ANOMALY: "text-warning",
  };
  const confidenceLabel: Record<string, string> = { high: "high confidence", medium: "medium confidence", low: "low confidence" };
</script>

<article class="rounded-tile border border-border bg-surface px-5 py-4 {compact ? '' : ''}">
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <span class="text-[10px] font-semibold uppercase tracking-[0.14em] {categoryStyle[signal.category] ?? 'text-fg-faint'}">{signal.category}</span>
    {#if isNew}
      <span class="chip chip-accent !px-1.5 !py-0 !text-[9px] uppercase">new</span>
    {/if}
    <span class="ml-auto flex items-center gap-2">
      <span class="text-[10px] uppercase tracking-[0.12em] text-fg-faint" title="Decision confidence — how much the evidence supports this comparison">{confidenceLabel[signal.confidence]}</span>
      <ProvenanceBadge level={signal.provenance} />
    </span>
  </div>
  <h3 class="mt-1.5 text-[15px] font-semibold text-fg">{signal.title}</h3>
  <p class="mt-1 text-[13px] leading-relaxed text-fg-muted">{signal.summary}</p>
  {#if !compact && signal.evidence.length > 0}
    <details class="group mt-2">
      <summary class="cursor-pointer text-[11px] font-medium text-fg-faint transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
        Why? ({signal.evidence.length} evidence lines)
      </summary>
      <ul class="mt-1.5 space-y-1 border-l border-border pl-3">
        {#each signal.evidence as line (line)}
          <li class="tnum text-[11.5px] leading-relaxed text-fg-muted">{line}</li>
        {/each}
      </ul>
      <p class="mt-1.5 text-[10.5px] leading-relaxed text-fg-faint">{signal.reason}</p>
      {#if signal.limitations.length > 0}
        <p class="mt-1 text-[10.5px] leading-relaxed text-fg-faint">Limitations: {signal.limitations.join(" ")}</p>
      {/if}
    </details>
  {/if}
  <div class="mt-2.5 flex flex-wrap items-center justify-between gap-2">
    <span class="tnum text-[12px] font-medium text-fg">
      {#if signal.metricAfter !== null}
        {signal.metricAfter.toLocaleString("en-US")} {signal.metricUnit}{signal.metricBefore !== null ? ` · baseline ${signal.metricBefore.toLocaleString("en-US")}` : ""}
      {:else}
        {signal.impact}
      {/if}
    </span>
    <a class="text-link text-[12px]" href={signal.actionUrl}>Open {signal.domain} →</a>
  </div>
</article>
