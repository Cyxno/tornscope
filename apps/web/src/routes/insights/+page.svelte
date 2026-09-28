<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import type { InsightsResponse } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { ALL_NAV_ITEMS } from "$lib/nav";
  import { categoryChips, categoryLabel, clickPathLabel, comparisonParts, confidenceChip, evidenceLine, kindLabel, sortInsights } from "$lib/insights-view";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";
  import * as td from "$lib/time-display.svelte.js";

  /**
   * Insights — observed shifts in your own data. Every card compares two
   * measured periods (current window vs baseline) and carries its evidence
   * and confidence. Loaded once: insights are slow-moving, so there is no
   * polling — a manual refresh is always available.
   */

  let data = $state<InsightsResponse | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  let category = $state<"all" | string>("all");

  async function load(silent = false) {
    if (silent) refreshing = true;
    else loading = true;
    error = null;
    try {
      data = await endpoints.insights();
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      if (!silent) data = null;
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  onMount(() => {
    void load();
  });

  const chips = $derived(data ? categoryChips(data.insights, data.kinds) : []);
  const filtered = $derived.by(() => {
    if (!data) return [];
    const rows = category === "all" ? data.insights : data.insights.filter((i) => i.category === category);
    return sortInsights(rows);
  });
</script>

<svelte:head><title>Insights · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Intelligence · Insights"
    title="Insights"
    description="Observed shifts in your own data — each one compares two measured periods and shows its evidence. No causal claims, no noise."
  >
    {#snippet actions()}
      <button class="btn btn-sm" disabled={refreshing} onclick={() => void load(true)}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load insights" hint={error} action={{ label: "Retry", run: () => void load() }} />
  {:else if data}
    {#if data.insights.length === 0}
      {#if data.insufficientHistory}
        <StateMessage
          state="empty"
          title="Insights need more history"
          hint="Insights compare measured periods of your own data — there is not enough recorded history yet. Keep the sync running and check back in a few days."
        />
      {:else}
        <StateMessage
          state="empty"
          title="Nothing worth flagging right now"
          hint="That's a good thing — your recent activity shows no shifts large enough to surface."
        />
      {/if}
    {:else}
      <!-- Category filter: chips from the kinds registry, grouped by category -->
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filter insights by category">
        {#each chips as chip (chip.category)}
          <button
            class="chip cursor-pointer {category === chip.category ? 'chip-accent font-semibold' : 'chip-quiet'}"
            aria-pressed={category === chip.category}
            onclick={() => (category = chip.category)}
          >
            {chip.label}
            {#if chip.category !== "all"}
              <span class="tnum text-fg-faint">{chip.count}</span>
            {/if}
          </button>
        {/each}
      </div>

      {#if data.insufficientHistory}
        <div class="rounded-tile border border-warning/25 bg-warning/5 px-4 py-2.5 text-[13px] text-warning">
          Your recorded history is still short — only the rules with enough measured data speak up. More insights appear as the history grows.
        </div>
      {/if}

      <section aria-label="Insights" class="space-y-4">
        {#if filtered.length === 0}
          <StateMessage state="empty" compact title="No insights in this category" hint="Try All, or another category." />
        {:else}
          {#each filtered as insight (insight.id)}
            {@const kind = kindLabel(insight.kind, data.kinds)}
            {@const cmp = comparisonParts(insight.comparison)}
            {@const conf = confidenceChip(insight.confidence)}
            {@const link = clickPathLabel(insight.clickPath, ALL_NAV_ITEMS)}
            <article class="min-w-0 rounded-card border border-border bg-surface p-5 shadow-panel">
              <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span class="text-[10px] font-medium uppercase tracking-wide text-fg-faint">{kind}</span>
                <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">{categoryLabel(insight.category)}</span>
                <span class={`chip ${conf.class} !px-1.5 !text-[9px] !font-semibold !uppercase !tracking-wide`} title={conf.title}>{conf.label}</span>
                <span class="ml-auto text-[11px] text-fg-faint">{td.displayDate(insight.occurredAt)}</span>
              </div>
              <h3 class="mt-2 text-[14px] font-semibold text-fg">{insight.title}</h3>
              <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-fg-muted">{insight.detail}</p>
              <p class="tnum mt-2.5 text-[13px] text-fg">
                {insight.comparison.metric}:
                <span class="text-fg-muted">{cmp.baseline}</span>
                → {cmp.current}
                {#if cmp.pct}
                  <span class="text-fg-muted">({cmp.pct})</span>
                {/if}
              </p>
              <p class="mt-1.5 text-[11px] text-fg-faint">{evidenceLine(insight.evidence, td.displayDate)}</p>
              <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                {#if insight.provenance === "inferred"}
                  <span
                    class="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint"
                    title="Concluded from evidence — sessions reconstructed from your logs"
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-info"></span>
                    inferred
                  </span>
                {:else}
                  <ProvenanceBadge level={insight.provenance} />
                {/if}
                {#if link}
                  <button class="text-link cursor-pointer text-xs font-medium" onclick={() => void goto(insight.clickPath)}>{link} →</button>
                {/if}
              </div>
            </article>
          {/each}
        {/if}
        <p class="text-[11px] text-fg-faint">
          {filtered.length} of {data.insights.length} insight{data.insights.length === 1 ? "" : "s"} shown · every insight compares two measured periods of your own history.
        </p>
      </section>
    {/if}
  {/if}
</div>
