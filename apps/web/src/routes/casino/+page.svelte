<script lang="ts">
  import type { CasinoSummaryResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoneyCompact } from "@tornscope/shared";
  import { createLoadGuard } from "$lib/loadGuard";
  import { activities as activitiesApi, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";
  import * as td from "$lib/time-display.svelte.js";

  let data = $state<CasinoSummaryResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const res = await activitiesApi.casino({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to });
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

<svelte:head><title>Casino · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Activity · Rewards"
    title="Casino"
    description="A retrospective ledger of your logged casino play — exact cash wagers and returns where Torn records them. Descriptive history only: past outcomes say nothing about future ones."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load casino analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    <dl class="grid grid-cols-2 gap-y-5 md:grid-cols-4 md:divide-x md:divide-border">
      <div class="md:pr-5">
        <dt class="text-[11px] font-medium text-fg-faint">Activities</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.activities}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Total wagered</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.totalWagered.value !== null ? formatMoneyCompact(data.totalWagered.value) : "—"}</dd>
        <dd class="mt-0.5"><ProvenanceBadge level="exact" /></dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Cash returned</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.cashReturned.value !== null ? formatMoneyCompact(data.cashReturned.value) : "—"}</dd>
      </div>
      <div class="md:pl-5">
        <dt class="text-[11px] font-medium text-fg-faint">Net cash</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold {data.netCash.value === null ? 'text-fg-faint' : data.netCash.value >= 0 ? 'text-positive' : 'text-negative'}">{data.netCash.value !== null ? formatSignedMoneyCompact(data.netCash.value) : "—"}</dd>
      </div>
    </dl>

    {#if data.bestResult || data.worstResult}
      <p class="text-[12px] leading-relaxed text-fg-faint">
        {#if data.bestResult}Best session: <span class="text-positive tnum">{formatSignedMoneyCompact(data.bestResult.net)}</span> ({data.bestResult.label}, {td.displayDate(data.bestResult.occurredAt)}).{/if}
        {#if data.worstResult} Worst session: <span class="text-negative tnum">{formatSignedMoneyCompact(data.worstResult.net)}</span> ({data.worstResult.label}, {td.displayDate(data.worstResult.occurredAt)}).{/if}
      </p>
    {/if}
    {#if data.activities === 0}
      <StateMessage
        state="empty"
        title="No logged casino activity in this range"
        hint="Casino plays appear as Torn logs sync. Games without exact cash payloads in the logs stay untracked rather than estimated."
      />
    {:else}
      <section class="section-rule" aria-label="Casino games">
        <h2 class="section-label">By game</h2>
        <div class="mt-3 overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Game</th>
                <th class="text-right">Events</th>
                <th class="text-right">Wagered</th>
                <th class="text-right">Cash won</th>
                <th class="text-right">Net</th>
                <th class="hidden md:table-cell text-right">Last played</th>
              </tr>
            </thead>
            <tbody>
              {#each data.games as game (game.game)}
                <tr>
                  <td class="font-medium text-fg">{game.label}</td>
                  <td class="tnum text-right text-fg-muted" title="ActivityEvent rows — multi-event games (placement + settlement) have more rows than plays">{game.plays}</td>
                  <td class="tnum text-right text-fg-muted">{game.wagered !== null ? formatMoneyCompact(game.wagered) : "—"}</td>
                  <td class="tnum text-right text-fg-muted">{game.cashWon !== null ? formatMoneyCompact(game.cashWon) : "—"}</td>
                  <td class="tnum text-right font-semibold {game.net === null ? 'text-fg-faint' : game.net >= 0 ? 'text-positive' : 'text-negative'}">
                    {game.net !== null ? formatSignedMoneyCompact(game.net) : "—"}
                  </td>
                  <td class="hidden md:table-cell tnum text-right text-fg-faint">{game.lastPlayedAt !== null ? td.displayDate(game.lastPlayedAt) : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
          All cash figures are exact values from Torn's own logs. "Events" counts ActivityEvent rows — multi-event games (bookie, blackjack, high-low, wheel) have one row per placement and per settlement, so rows exceed plays. Stakes are counted once (owned by the placement/start). Bookie withdrawals are balance movements, excluded from winnings and net. Pending placements are never losses. Past results never imply future outcomes.
        </p>
      </section>
    {/if}
  {/if}
</div>
