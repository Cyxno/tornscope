<script lang="ts">
  import type { DashboardResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatKpiValue, periodLabel } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import { formatRelative } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel, hourLabel, tealArea } from "$lib/charts";

  let data = $state<DashboardResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  async function load() {
    loading = true;
    error = null;
    try {
      data = await endpoints.dashboard({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to });
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void dateRange.preset;
    void dateRange.from;
    void reloadToken;
    void load();
  });

  /* Labels follow the selected global range — never a hardcoded window. */
  const period = $derived(periodLabel(dateRange.preset));

  /* Hero net worth split into currency symbol + magnitude */
  const nw = $derived.by(() => {
    const value = data?.netWorth.value ?? null;
    if (value === null || value === undefined) return null;
    const formatted = formatMoneyCompact(value);
    return { symbol: formatted.slice(0, 1), magnitude: formatted.slice(1) };
  });

  const networthOption = $derived.by(() => {
    if (!data || data.networthSeries.length === 0) return null;
    const interval = data.range.interval;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: { ...GRID, top: 16 },
      xAxis: timeAxis(data.networthSeries.map((p) => (interval === "hour" ? hourLabel(p.t) : dayLabel(p.t)))),
      yAxis: valueAxis(),
      series: [
        {
          name: "Net worth",
          type: "line",
          data: data.networthSeries.map((p) => p.total),
          // Sparse early history must be visible as real points, not a guess.
          showSymbol: data.networthSeries.length < 40,
          smooth: 0.25,
          lineStyle: { color: C.accent, width: 2 },
          areaStyle: tealArea(),
        },
      ],
    };
  });

  const drugOption = $derived.by(() => {
    if (!data || data.drugUseSeries.every((p) => p.good === 0 && p.bad === 0)) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: ["Good", "Overdose"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(data.drugUseSeries.map((p) => dayLabel(p.t))),
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: C.label, fontSize: 10.5 }, splitLine: { lineStyle: { color: C.splitLine } }, axisLine: { show: false } },
      series: [
        { name: "Good", type: "bar", stack: "use", data: data.drugUseSeries.map((p) => p.good), barMaxWidth: 12, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
        { name: "Overdose", type: "bar", stack: "use", data: data.drugUseSeries.map((p) => p.bad), barMaxWidth: 12, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });

  const travelOption = $derived.by(() => {
    if (!data || data.travelProfitSeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: GRID,
      xAxis: timeAxis(data.travelProfitSeries.map((p) => dayLabel(p.t))),
      yAxis: valueAxis(),
      series: [
        {
          name: "Estimated profit",
          type: "bar",
          data: data.travelProfitSeries.map((p) => p.profit),
          barMaxWidth: 12,
          itemStyle: { color: C.accentStrong, borderRadius: [3, 3, 0, 0] },
        },
      ],
    };
  });

  const topIncome = $derived(data?.incomeByCategory.slice(0, 5) ?? []);
</script>

<div class="space-y-10">
  <PageHeader eyebrow="Overview" title="The big picture" description="A living summary of your Torn life — wealth, habits and movement, tracked continuously from your own server.">
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load your dashboard" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    <!-- Hero: net worth + quiet stat strip -->
    <section class="overflow-hidden rounded-2xl border border-border bg-surface shadow-panel">
      <div class="px-7 pb-7 pt-8">
        <div class="flex items-center gap-3">
          <span class="text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-faint">Net worth</span>
          <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">exact · Torn</span>
        </div>
        <div class="mt-3 flex items-baseline gap-1">
          {#if nw}
            <span class="text-2xl font-medium text-fg-muted">{nw.symbol}</span>
            <span class="tnum text-6xl font-semibold tracking-tight text-fg">{nw.magnitude}</span>
          {:else}
            <span class="font-display text-4xl text-fg-faint">No snapshot yet</span>
          {/if}
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px]">
          <span class="flex items-baseline gap-1.5" class:text-positive={(data.networthChange.value ?? 0) >= 0} class:text-negative={(data.networthChange.value ?? 0) < 0}>
            <span class="tnum font-semibold">
              {#if data.networthCoverage === "none"}
                Insufficient history
              {:else}
                {data.networthChange.value === null ? "—" : `${(data.networthChange.value ?? 0) >= 0 ? "+" : ""}${formatMoneyCompact(data.networthChange.value)}`}
              {/if}
            </span>
            <span class="text-fg-faint">
              {data.networthCoverage === "partial" ? `tracked ${period.toLowerCase()} networth change` : `${period} networth change`}
            </span>
          </span>
          <span class="flex items-baseline gap-1.5 text-fg-muted">
            <span class="tnum font-semibold text-fg">{formatKpiValue(data.travelProfit)}</span>
            <span class="text-fg-faint">Estimated Travel Profit</span>
          </span>
          {#if data.lastSyncAt}
            <span class="text-fg-faint">last sync {formatRelative(data.lastSyncAt)}</span>
          {/if}
        </div>
      </div>
      <div class="grid grid-cols-2 gap-px border-t border-border bg-border md:grid-cols-4">
        <Stat label="Cash" value={formatKpiValue(data.cash)} provenance="exact" />
        <Stat label="{period} income" value={formatKpiValue(data.income)} provenance="derived" tone="positive" sub={data.income.availability === "incomplete" ? "some logs unclassified" : null} />
        <Stat label="{period} expenses" value={formatKpiValue(data.expenses)} provenance="derived" tone="negative" sub={data.expenses.availability === "incomplete" ? "some logs unclassified" : null} />
        <Stat label="Rehab spend" value={formatKpiValue(data.rehabSpend)} provenance={data.rehabSpend.provenance} />
      </div>
    </section>

    <!-- Net worth over time -->
    <Panel
      title="Net worth over time"
      caption={data.networthTrackingSince !== null
        ? `Real snapshots from the sync worker · Tracking since ${new Date(data.networthTrackingSince * 1000).toISOString().slice(0, 10)} — no data is invented before that point`
        : "Hourly snapshots from the sync worker — exact Torn-provided values"}
      flush
    >
      {#if !networthOption}
        <StateMessage state="empty" title="No networth history in this range" hint="Snapshots appear as the worker runs. Try a wider range or check Sync Status." />
      {:else}
        <Chart option={networthOption} height={380} />
      {/if}
    </Panel>

    <!-- Flow + activity -->
    <section class="grid gap-6 lg:grid-cols-5">
      <div class="lg:col-span-3">
        <Panel title="Where money came from" caption="Top income sources in range">
          {#if topIncome.length === 0}
            <StateMessage state="empty" title="No money events in this range" />
          {:else}
            <ul class="space-y-4">
              {#each topIncome as row (row.category)}
                <li>
                  <div class="flex items-baseline justify-between gap-3 text-[13px]">
                    <span class="capitalize text-fg">{row.category}</span>
                    <span class="tnum font-medium text-positive">{formatMoneyCompact(row.total)}</span>
                  </div>
                  <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div class="h-full rounded-full bg-positive/80" style="width: {Math.round((row.total / (topIncome[0]?.total || 1)) * 100)}%"></div>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </Panel>
      </div>
      <div class="lg:col-span-2">
        <Panel title="Recent activity" caption="Latest entries from your timeline">
          {#snippet actions()}
            <a href="/timeline" class="text-xs font-medium text-accent transition-opacity hover:opacity-80">All →</a>
          {/snippet}
          {#if data.recentTimeline.length === 0}
            <StateMessage state="empty" title="No activity in this range" />
          {:else}
            <ul class="divide-y divide-border">
              {#each data.recentTimeline.slice(0, 7) as event (event.id)}
                <li class="flex items-baseline justify-between gap-3 py-2.5 first:pt-0">
                  <div class="min-w-0">
                    <p class="truncate text-[13px] text-fg">{event.title}</p>
                    <p class="text-[11px] text-fg-faint">{formatRelative(event.occurredAt)}</p>
                  </div>
                  {#if event.amount !== null && event.amount !== undefined}
                    <span class="tnum shrink-0 text-[13px] font-medium {(event.amount ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">
                      {(event.amount ?? 0) >= 0 ? '+' : ''}{formatMoneyCompact(event.amount)}
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </Panel>
      </div>
    </section>

    <!-- Habit + movement -->
    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Drug use" caption="Good uses vs overdoses per day" flush>
        {#snippet actions()}
          <a href="/drugs" class="pr-4 text-xs font-medium text-accent transition-opacity hover:opacity-80">Explore →</a>
        {/snippet}
        {#if !drugOption}
          <StateMessage state="empty" title="No drug events in this range" />
        {:else}
          <Chart option={drugOption} height={260} />
        {/if}
      </Panel>
      <Panel title="Faction" caption="Ranked war status and my payouts" flush>
        {#if !data.faction}
          <StateMessage state="empty" title="No faction membership" />
        {:else}
          <div class="grid grid-cols-3 gap-px bg-border">
            <div class="bg-surface p-5 text-center">
              <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Faction</p>
              <p class="mt-1 truncate font-medium text-fg" title={data.faction.name ?? ""}>{data.faction.name ?? "—"}</p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Last war</p>
              <p class="mt-1 font-medium text-fg">
                {#if data.faction.lastWar}
                  <span class={data.faction.lastWar.result === "win" ? "text-positive" : data.faction.lastWar.result === "loss" ? "text-negative" : "text-fg-muted"}>
                    {data.faction.lastWar.result === "ongoing" ? "ongoing" : data.faction.lastWar.result}
                  </span>
                  {/if}
              </p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">My payouts</p>
              <p class="tnum mt-1 font-semibold text-positive">{formatMoneyCompact(data.faction.myPayouts)}</p>
            </div>
          </div>
          <p class="px-5 pt-3 text-xs text-fg-faint">
            {period} faction payouts received. <a href="/faction" class="text-accent">Explore →</a>
          </p>
        {/if}
      </Panel>
      <Panel title="Crimes" caption="Attempts, success rate and value in range" flush>
        {#if !data.crimes}
          <StateMessage state="empty" title="No crime attempts in this range" />
        {:else}
          <div class="grid grid-cols-3 gap-px bg-border">
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-fg">{data.crimes.attempts}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">attempts</p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-positive">{data.crimes.successRate !== null ? Math.round(data.crimes.successRate * 100) + "%" : "—"}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">success</p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-accent">{data.crimes.totalValue !== null ? formatMoneyCompact(data.crimes.totalValue) : "—"}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">value (est.)</p>
            </div>
          </div>
          <p class="px-5 pt-3 text-xs text-fg-faint">
            {period} crime activity — cash exact, item values estimated from the Torn catalog. <a href="/crimes" class="text-accent">Explore →</a>
          </p>
        {/if}
      </Panel>
      <Panel title="Combat" caption="Attacks made and wins in range" flush>
        {#if !data.combat}
          <StateMessage state="empty" title="No combat activity in this range" />
        {:else}
          <div class="grid grid-cols-2 gap-px bg-border">
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-fg">{data.combat.attacksMade}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">attacks made</p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-positive">{data.combat.wins}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">wins</p>
            </div>
          </div>
          <p class="px-5 pt-3 text-xs text-fg-faint">
            {period} combat activity — exact from your Torn attacks record. <a href="/combat" class="text-accent">Explore →</a>
          </p>
        {/if}
      </Panel>
      <Panel title="Travel profit" caption="Estimated profit by departure day" flush>
        {#snippet actions()}
          <a href="/travel" class="pr-4 text-xs font-medium text-accent transition-opacity hover:opacity-80">Explore →</a>
        {/snippet}
        {#if !travelOption}
          <StateMessage state="empty" title="No trips in this range" />
        {:else}
          <Chart option={travelOption} height={260} />
        {/if}
      </Panel>
    </section>
  {/if}
</div>
