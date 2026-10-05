<script lang="ts">
  import type { ActivitySummaryResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoneyCompact } from "@tornscope/shared";
  import { createLoadGuard } from "$lib/loadGuard";
  import { activities as activitiesApi, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import * as td from "$lib/time-display.svelte.js";

  let data = $state<ActivitySummaryResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const res = await activitiesApi.activity({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to });
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

  function subtypeLabel(row: { activityType: string; subtype: string | null }): string {
    if (row.subtype) return row.subtype.replace(/-/g, " ");
    return row.activityType;
  }
</script>

<svelte:head><title>Activity · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Activity · Overview"
    title="Activity & value"
    description="What your logged activity was worth, per domain: exact cash from Torn's own logs, item value estimated at current catalog prices, and rewards that stay unpriced rather than guessed. Exact and estimated are never merged."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load activity analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    <dl class="grid grid-cols-2 gap-y-5 md:grid-cols-4 md:divide-x md:divide-border">
      <div class="md:pr-5">
        <dt class="text-[11px] font-medium text-fg-faint">Activities</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.activities}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Exact cash net</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold {data.exactNetCash === null ? 'text-fg-faint' : data.exactNetCash >= 0 ? 'text-positive' : 'text-negative'}">{data.exactNetCash !== null ? formatSignedMoneyCompact(data.exactNetCash) : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">exact — from Torn's own logs</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Item rewards (est.)</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.estimatedItemValue.value !== null ? formatMoneyCompact(data.estimatedItemValue.value) : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">estimated — current market prices</dd>
      </div>
      <div class="md:pl-5">
        <dt class="text-[11px] font-medium text-fg-faint">Unpriced activities</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.unpricedActivities}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">kept visible — never counted as zero</dd>
      </div>
    </dl>

    {#if data.activities === 0}
      <StateMessage
        state="empty"
        title="No normalized activity in this range"
        hint="Activity appears as Torn logs sync and the historical repair runs."
      />
    {:else}
      <section class="section-rule" aria-label="Value by activity">
        <h2 class="section-label">Value by activity</h2>
        <div class="mt-3 overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Domain</th>
                <th class="text-right">Activities</th>
                <th class="text-right">Cash in</th>
                <th class="text-right">Cash out</th>
                <th class="text-right">Exact net</th>
                <th class="hidden md:table-cell text-right">Items (est.)</th>
                <th class="hidden md:table-cell text-right">Progression</th>
                <th class="hidden lg:table-cell text-right">Ledger</th>
              </tr>
            </thead>
            <tbody>
              {#each data.domains as d (d.domain)}
                <tr>
                  <td class="font-medium text-fg">{d.label}</td>
                  <td class="tnum text-right text-fg-muted">{d.activities}</td>
                  <td class="tnum text-right text-fg-muted">{d.cashReceived !== null ? formatMoneyCompact(d.cashReceived) : "—"}</td>
                  <td class="tnum text-right text-fg-muted">{d.cashSpent !== null ? formatMoneyCompact(d.cashSpent) : "—"}</td>
                  <td class="tnum text-right font-semibold {d.exactNetCash === null ? 'text-fg-faint' : d.exactNetCash >= 0 ? 'text-positive' : 'text-negative'}">{d.exactNetCash !== null ? formatSignedMoneyCompact(d.exactNetCash) : "—"}</td>
                  <td class="hidden md:table-cell tnum text-right text-fg-muted">{d.estimatedItemValue !== null ? formatMoneyCompact(d.estimatedItemValue) : "—"}</td>
                  <td class="hidden md:table-cell tnum text-right text-fg-muted">
                    {#if d.progressionTokens !== null}{d.progressionTokens.toLocaleString()} credits{:else if d.progressionPoints !== null}{d.progressionPoints.toLocaleString()} points{:else}—{/if}
                  </td>
                  <td class="hidden lg:table-cell text-right text-[11px] {d.ledgerLinked ? 'text-fg-muted' : 'text-fg-faint'}">{d.ledgerLinked ? "ledger + semantic" : "semantic-only"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
          "Cash in" is what the activity paid you; "cash out" is what it cost. Semantic-only domains have no money logs in Torn's API — their cash is reported here once, never added to the ledger totals again.
        </p>
      </section>

      {#each data.domains as d (d.domain)}
        {#if d.breakdown.length > 1 || (d.breakdown.length === 1 && d.breakdown[0] && (d.breakdown[0].subtype !== null || d.breakdown[0].cashSpent !== null))}
          <section class="section-rule" aria-label={d.label}>
            <h2 class="section-label">{d.label}</h2>
            <div class="mt-3 overflow-x-auto">
              <table class="tsv-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th class="text-right">Count</th>
                    <th class="text-right">Cash in</th>
                    <th class="text-right">Cash out</th>
                    <th class="text-right">Net</th>
                    <th class="hidden md:table-cell text-right">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {#each d.breakdown as b (b.activityType + (b.subtype ?? ""))}
                    <tr>
                      <td class="font-medium text-fg capitalize">{subtypeLabel(b)}</td>
                      <td class="tnum text-right text-fg-muted">{b.count}</td>
                      <td class="tnum text-right text-fg-muted">{b.cashReceived !== null ? formatMoneyCompact(b.cashReceived) : "—"}</td>
                      <td class="tnum text-right text-fg-muted">{b.cashSpent !== null ? formatMoneyCompact(b.cashSpent) : "—"}</td>
                      <td class="tnum text-right font-semibold {b.net === null ? 'text-fg-faint' : b.net >= 0 ? 'text-positive' : 'text-negative'}">{b.net !== null ? formatSignedMoneyCompact(b.net) : "—"}</td>
                      <td class="hidden md:table-cell tnum text-right text-fg-faint">{d.lastActivityAt !== null ? td.displayDate(d.lastActivityAt) : "—"}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </section>
        {/if}
      {/each}

      {#if data.reconciliation.length > 0}
        <section class="section-rule" aria-label="Ledger reconciliation">
          <h2 class="section-label">Ledger reconciliation</h2>
          <div class="mt-3 overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th class="text-right">Semantic cash</th>
                  <th class="text-right">Ledger cash</th>
                  <th class="text-right">Difference</th>
                </tr>
              </thead>
              <tbody>
                {#each data.reconciliation as r (r.domain)}
                  <tr>
                    <td class="font-medium text-fg capitalize">{r.domain}</td>
                    <td class="tnum text-right text-fg-muted">{r.activityCash !== null ? formatSignedMoneyCompact(r.activityCash) : "—"}</td>
                    <td class="tnum text-right text-fg-muted">{r.ledgerCash !== null ? formatSignedMoneyCompact(r.ledgerCash) : "n/a"}</td>
                    <td class="tnum text-right text-fg-muted">{r.difference !== null ? formatSignedMoneyCompact(r.difference) : "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#each data.reconciliation as r (r.domain)}
            {#if r.note}
              <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">{r.domain}: {r.note}</p>
            {/if}
          {/each}
        </section>
      {/if}
    {/if}
  {/if}
</div>
