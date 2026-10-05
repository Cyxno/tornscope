<script lang="ts">
  import type { RewardsSummaryResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoneyCompact } from "@tornscope/shared";
  import { createLoadGuard } from "$lib/loadGuard";
  import { activities as activitiesApi, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import * as td from "$lib/time-display.svelte.js";

  let data = $state<RewardsSummaryResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const res = await activitiesApi.rewards({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to });
      if (!guard.isCurrent(seq)) return;
      data = res;
    } catch (err) {
      if (!guard.isCurrent(seq)) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      if (guard.isCurrent(seq)) loading = false;
    }
  }

  $effect(() => {
    void dateRange.preset;
    void dateRange.from;
    void reloadToken;
    void load();
  });
</script>

<svelte:head><title>Rewards · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Activity · Rewards"
    title="Openables & rewards"
    description="Supply packs, caches, wallets and similar openings — what went in, what came out, valued at current market prices where the catalog allows. Estimated where exact values don't exist."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load rewards analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    <dl class="grid grid-cols-2 gap-y-5 md:grid-cols-3 md:divide-x md:divide-border">
      <div class="md:pr-5">
        <dt class="text-[11px] font-medium text-fg-faint">Openings</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.openings}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Container types</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.containerTypes}</dd>
      </div>
      <div class="md:pl-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Exact cash rewards from openings whose payloads carry money">Cash received</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.cashReceived !== null ? formatMoneyCompact(data.cashReceived) : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">exact</dd>
      </div>
    </dl>

    <dl class="grid grid-cols-1 gap-y-5 md:grid-cols-3 md:divide-x md:divide-border">
      <div class="md:pr-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Opened items valued at current catalog market prices — not the historical price">Input value (est.)</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.inputValueEstimate.value !== null ? formatMoneyCompact(data.inputValueEstimate.value) : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">estimated — current market prices</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Reward items valued at current catalog market prices — not the historical price">Item rewards (est.)</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.itemValueEstimate.value !== null ? formatMoneyCompact(data.itemValueEstimate.value) : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">estimated — current market prices</dd>
      </div>
      <div class="md:pl-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Exact cash plus estimated item rewards minus estimated input value">Estimated net</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold {data.estimatedNet.value === null ? 'text-fg-faint' : data.estimatedNet.value >= 0 ? 'text-positive' : 'text-negative'}">{data.estimatedNet.value !== null ? formatSignedMoneyCompact(data.estimatedNet.value) : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">{data.estimatedNet.provenance === 'partial-estimate' ? 'partial estimate — unpriced rewards excluded' : data.valuationCoverage === 'unpriced' ? 'unpriced' : 'mixed: exact cash, estimated items'}</dd>
      </div>
    </dl>

    {#if data.openings === 0}
      <StateMessage
        state="empty"
        title="No logged openings in this range"
        hint="Openings appear as Torn logs sync. Openables without reward components in the logs stay untracked rather than estimated."
      />
    {:else}
      {#if data.topItemRewards.length > 0}
        <section class="section-rule" aria-label="Reward distribution">
          <h2 class="section-label">Reward distribution — top items</h2>
          <div class="mt-3 overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th class="text-right">Quantity</th>
                  <th class="hidden md:table-cell text-right">Unit price (est.)</th>
                  <th class="text-right">Value (est.)</th>
                </tr>
              </thead>
              <tbody>
                {#each data.topItemRewards as item (item.itemId)}
                  <tr>
                    <td class="font-medium text-fg">{item.label ?? `Item #${item.itemId}`}</td>
                    <td class="tnum text-right text-fg-muted">{item.qty}</td>
                    <td class="hidden md:table-cell tnum text-right text-fg-muted">{item.unitPriceEstimate !== null ? formatMoneyCompact(item.unitPriceEstimate) : "—"}</td>
                    <td class="tnum text-right font-semibold text-fg">{item.valueEstimate !== null ? formatMoneyCompact(item.valueEstimate) : "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if data.unpricedItemQty > 0}
            <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
              {data.unpricedItemQty} reward/input units have no catalog price and are shown as unpriced — never counted as zero.{data.malformedComponents > 0 ? ` ${data.malformedComponents} reward components no longer parse (payload drift) and are excluded from every total.` : ""}
            </p>
          {/if}
        </section>
      {/if}
      <section class="section-rule" aria-label="Openable types">
        <h2 class="section-label">By container type</h2>
        <div class="mt-3 overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Container</th>
                <th class="text-right">Opened</th>
                <th class="text-right">Cash received</th>
                <th class="hidden md:table-cell text-right">Last opened</th>
              </tr>
            </thead>
            <tbody>
              {#each data.types as t (t.activityType)}
                <tr>
                  <td class="font-medium text-fg">{t.label}</td>
                  <td class="tnum text-right text-fg-muted">{t.openings}</td>
                  <td class="tnum text-right text-fg-muted">{t.cashReward !== null ? formatMoneyCompact(t.cashReward) : "—"}</td>
                  <td class="hidden md:table-cell tnum text-right text-fg-faint">{t.lastOpenedAt !== null ? td.displayDate(t.lastOpenedAt) : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
          Cash rewards are exact values from Torn's own logs. Item quantities are exact; their monetary values use current catalog prices and are labeled estimated — past market prices are not retroactively applied.
        </p>
      </section>
    {/if}
  {/if}
</div>
