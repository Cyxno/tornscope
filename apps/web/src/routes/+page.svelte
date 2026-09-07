<script lang="ts">
  import type { DashboardResponse, TodayResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatKpiValue, periodLabel, formatDate, formatSignedMoney } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
import LiveNow from "$lib/components/LiveNow.svelte";
  import { incomeLabel, expenseLabel } from "$lib/labels";
  import { dateRange, me } from "$lib/state.svelte";
  import { clientPermissionMessage } from "$lib/capabilities";
  import { formatRelative } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel, hourLabel, tealArea } from "$lib/charts";

  let data = $state<DashboardResponse | null>(null);
  let today = $state<TodayResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  async function load() {
    loading = true;
    error = null;
    try {
      const [dash, todayRes] = await Promise.all([
        endpoints.dashboard({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to }),
        endpoints.today().catch(() => null),
      ]);
      data = dash;
      today = todayRes;
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
  const topExpenses = $derived(data?.expensesByCategory.slice(0, 5) ?? []);

  /** Semantic badges per category row: conversion vs true income/expense. */
  const SALES_CATEGORIES = new Set(["bazaar", "items", "trading", "auction"]);
  const ASSET_CATEGORIES = new Set(["bazaar", "items", "trading", "auction", "points", "stock", "travel", "plushie", "flower", "drugs"]);
  const isInflowConversion = (category: string): boolean => SALES_CATEGORIES.has(category) || category === "points";
  const isOutflowConversion = (category: string): boolean => ASSET_CATEGORIES.has(category);

  // Permission states for the tiles: never a fake zero when the key cannot
  // see the underlying data at all.
  const caps = $derived(me.data?.capabilities ?? null);
  const logsBlocked = $derived(clientPermissionMessage(caps, "money_cash_flow"));
  const attacksBlocked = $derived(clientPermissionMessage(caps, "combat_history"));
  const networthBlocked = $derived(clientPermissionMessage(caps, "networth_history"));
</script>

<svelte:head><title>Overview · TornScope</title></svelte:head>

<div class="space-y-10">
  <PageHeader eyebrow="Overview" title="The big picture" description="A living summary of your Torn life — wealth, habits and movement, tracked continuously on the TornScope server.">
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
          <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">exact · official Torn figure</span>
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
            <span class="text-fg-faint" title="Snapshot delta from official Torn net worth: includes item/stock/property price moves, cash and asset movement. Not a profit figure.">
              {#if data.networthCoverage === "none"}
                Net Worth Change
              {:else if data.networthCoverage === "partial" && data.financial.netWorthMeasuredFrom !== null}
                Net Worth Change · snapshots {formatDate(data.financial.netWorthMeasuredFrom)} → {data.financial.netWorthMeasuredTo !== null ? formatDate(data.financial.netWorthMeasuredTo) : "now"} · partial coverage of range
              {:else}
                Net Worth Change · snapshots {data.financial.netWorthMeasuredFrom !== null ? formatDate(data.financial.netWorthMeasuredFrom) : ""} → {data.financial.netWorthMeasuredTo !== null ? formatDate(data.financial.netWorthMeasuredTo) : "now"}
              {/if}
            </span>
          </span>
          <span class="flex items-baseline gap-1.5 text-fg-muted">
            <span class="tnum font-semibold text-fg">{formatKpiValue(data.travelProfit)}</span>
            <span class="text-fg-faint">Estimated Travel Profit</span>
          </span>
          {#if data.extendedWealth.value !== null}
            <span class="flex items-baseline gap-1.5 text-fg-muted" title="Official Torn net worth plus wealth Torn does not count in that figure.">
              <span class="tnum font-semibold text-fg">{formatMoneyCompact(data.extendedWealth.value)}</span>
              <span class="text-fg-faint">
                Extended wealth
                {#if data.extendedWealth.factionBalance !== null}
                  · incl. {formatMoneyCompact(data.extendedWealth.factionBalance)} withdrawable faction balance
                {/if}
              </span>
            </span>
          {/if}
          {#if data.lastSyncAt}
            <span class="text-fg-faint">last sync {formatRelative(data.lastSyncAt)}</span>
          {/if}
        </div>
      </div>
      <div class="grid grid-cols-2 gap-px border-t border-border bg-border md:grid-cols-4">
        <Stat label="Cash" value={formatKpiValue(data.cash)} provenance="exact" />
        <Stat
          label="{period} Cash received"
          value={formatKpiValue(data.financial.cashInflow)}
          provenance="derived"
          tone="positive"
          title="Cash that entered the wallet (technical label: cash inflow). Earnings and asset sales are broken out below — cash received is not profit."
          sub={`earned ${formatMoneyCompact(data.financial.cashReceived?.earned.total ?? data.financial.trueIncome)} · asset sales ${formatMoneyCompact(data.financial.cashReceived?.assetSales.total ?? data.financial.assetSales)}`}
        />
        <Stat
          label="{period} Cash spent"
          value={formatKpiValue(data.financial.cashOutflow)}
          provenance="derived"
          tone="negative"
          title="Cash that left the wallet (technical label: cash outflow). Most spending buys assets you still own."
          sub={`true expenses ${formatMoneyCompact(data.financial.trueExpense)} · asset purchases ${formatMoneyCompact(data.financial.assetPurchases)}`}
        />
        <Stat
          label="{period} Earned income"
          value={logsBlocked ? "—" : formatMoneyCompact(data.financial.trueIncome)}
          provenance="derived"
          tone="positive"
          title="Money earned — raises total wealth (salary, crime, payouts). Asset sales are NOT income: the items left your inventory."
          sub={`net worth change ${data.networthCoverage === "none" ? "—" : `${(data.networthChange.value ?? 0) >= 0 ? "+" : ""}${formatMoneyCompact(data.networthChange.value)}`}`}
        />
      </div>
    </section>

    <!-- Right now: live state chips (same Today source — one calculation) -->
    <LiveNow today={today} onOpenToday={() => (window.location.href = "/today")} />

    <!-- Net worth over time -->
    <Panel
      title="Net worth over time"
      caption={data.networthTrackingSince !== null
        ? `Real snapshots from the sync worker · Tracking since ${formatDate(data.networthTrackingSince)} — no data is invented before that point`
        : "Hourly snapshots from the sync worker — exact Torn-provided values"}
      flush
    >
      {#snippet actions()}
        <a href="/economy" class="pr-4 text-xs font-medium text-accent transition-opacity hover:opacity-80">Explore →</a>
      {/snippet}
      {#if !networthOption}
        <StateMessage state={networthBlocked ? "permission" : "empty"} title={networthBlocked ? networthBlocked.title : "No networth history in this range"} hint={networthBlocked ? networthBlocked.hint : "Snapshots appear as the worker runs. Try a wider range or check Sync Status."} />
      {:else}
        <Chart option={networthOption} height={380} />
      {/if}
    </Panel>

    <!-- Wallet: actual cash movement through the wallet (distinct from wealth) -->
    <section aria-label="Wallet movement" class="space-y-3">
      <div class="flex items-center justify-between">
        <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">Wallet — actual cash on hand and its movement</h2>
        <a href="/economy" class="text-xs font-medium text-accent transition-opacity hover:opacity-80">Economy →</a>
        {#if data.wallet.coverage === "partial"}
          <span class="text-[11px] text-warning">partial snapshot coverage</span>
        {/if}
      </div>
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Cash on hand" value={formatKpiValue(data.cash)} provenance="exact" tone="accent" />
        <Stat label="{period} Wallet inflows" value={formatMoneyCompact(data.wallet.walletInflow)} provenance="exact" tone="positive" sub={`bank withdrawals ${formatMoneyCompact(data.wallet.bankWithdrawals)}`} />
        <Stat label="{period} Wallet outflows" value={formatMoneyCompact(data.wallet.walletOutflow)} provenance="exact" tone="negative" sub={`bank investments ${formatMoneyCompact(data.wallet.bankDeposits)}`} />
        <Stat
          label="{period} Net wallet movement"
          value={formatSignedMoney(data.wallet.walletInflow - data.wallet.walletOutflow)}
          provenance="exact"
          tone={data.wallet.walletInflow - data.wallet.walletOutflow >= 0 ? "positive" : "negative"}
        />
      </div>
      {#if data.wallet.coverage !== "unavailable" && data.wallet.startingCash !== null}
        <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
          <span class="font-medium text-fg">Cash bridge:</span>
          starting {formatMoneyCompact(data.wallet.startingCash)}
          + received {formatMoneyCompact(data.wallet.walletInflow)}
          − spending &amp; bank deposits {formatMoneyCompact(data.wallet.walletOutflow)}
          = expected {formatMoneyCompact(data.wallet.expectedEndingCash ?? 0)}
          <span class="mx-1.5 text-border-strong">·</span>
          actual wallet now {formatMoneyCompact(data.wallet.actualEndingCash ?? 0)}
          {#if data.wallet.factionBalanceCredits > 0}
            <span class="mx-1.5 text-border-strong">·</span>
            <span class="text-fg-faint">
              OC payouts {formatMoneyCompact(data.wallet.factionBalanceCredits)} went to your faction balance (withdrawable there), not your wallet
            </span>
          {/if}
          {#if data.wallet.unreconciled !== null}
            <span class="mx-1.5 text-border-strong">·</span>
            <span class={Math.abs(data.wallet.unreconciled) < 1000 ? "text-fg-faint" : "text-warning"}>
              reconciliation difference {formatSignedMoney(data.wallet.unreconciled)}{Math.abs(data.wallet.unreconciled) < 1000 ? "" : " — source coverage is incomplete for part of the range"}
            </span>
          {/if}
        </p>
        <p class="text-xs text-fg-faint">
          Wallet movement is cash arithmetic, not profit: most outgoing cash in Torn is immediately re-invested
          (bank terms, points, items), so wallet inflows − outflows rarely equal “money left over”.
        </p>
      {:else}
        <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs text-fg-faint">
          Wallet reconciliation needs net worth snapshots at both ends of the range — the tracked history does not cover this range yet.
        </p>
      {/if}
    </section>

    <!-- Flow + activity -->
    <section class="grid gap-6 lg:grid-cols-6">
      <div class="lg:col-span-2">
        <Panel title="Cash received" caption="Where incoming cash came from — earnings and asset sales are different things">
      {#snippet actions()}
        <a href="/economy" class="pr-4 text-xs font-medium text-accent transition-opacity hover:opacity-80">Explore →</a>
      {/snippet}
          {#if logsBlocked}
            <StateMessage state="permission" title={logsBlocked.title} hint={logsBlocked.hint} />
          {:else if data.financial.cashReceived}
            {@const cr = data.financial.cashReceived}
            <div class="space-y-4 text-[13px]">
              <div class="flex items-baseline justify-between">
                <span class="font-medium text-fg">Cash received</span>
                <span class="tnum font-semibold text-positive">{formatMoneyCompact(cr.total)}</span>
              </div>
              <div>
                <div class="flex items-baseline justify-between">
                  <span class="font-medium text-fg">Earned income</span>
                  <span class="tnum text-positive">{formatMoneyCompact(cr.earned.total)}</span>
                </div>
                <ul class="mt-1.5 space-y-1 pl-3 text-xs text-fg-muted">
                  {#each cr.earned.rows as row (row.key)}
                    <li class="flex items-baseline justify-between gap-3">
                      <span>{row.label}</span>
                      <span class="tnum">{formatMoneyCompact(row.amount)}</span>
                    </li>
                  {/each}
                  {#if cr.earned.rows.length === 0}
                    <li class="text-fg-faint">No earned income in this range</li>
                  {/if}
                </ul>
              </div>
              <div>
                <div class="flex items-baseline justify-between">
                  <span class="font-medium text-fg">Asset sales</span>
                  <span class="tnum text-fg-muted" title="Cash received for something you owned — a conversion, not earnings. The items left your inventory.">{formatMoneyCompact(cr.assetSales.total)}</span>
                </div>
                <ul class="mt-1.5 space-y-1 pl-3 text-xs text-fg-muted">
                  {#each cr.assetSales.rows as row (row.key)}
                    <li class="flex items-baseline justify-between gap-3">
                      <span>{row.label}</span>
                      <span class="tnum">{formatMoneyCompact(row.amount)}</span>
                    </li>
                  {/each}
                  {#if cr.assetSales.rows.length === 0}
                    <li class="text-fg-faint">No asset sales in this range</li>
                  {/if}
                </ul>
              </div>
              {#if cr.other.rows.length > 0}
                <div>
                  <div class="flex items-baseline justify-between">
                    <span class="font-medium text-fg">Other received</span>
                    <span class="tnum text-fg-muted">{formatMoneyCompact(cr.other.total)}</span>
                  </div>
                  <ul class="mt-1.5 space-y-1 pl-3 text-xs text-fg-muted">
                    {#each cr.other.rows as row (row.key)}
                      <li class="flex items-baseline justify-between gap-3">
                        <span>{row.label}</span>
                        <span class="tnum">{formatMoneyCompact(row.amount)}</span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
              {#if cr.unclassified.count > 0}
                <p class="text-[11px] text-warning">
                  {formatMoneyCompact(cr.unclassified.total)} across {cr.unclassified.count} entr{cr.unclassified.count === 1 ? "y" : "ies"} could not be classified and is NOT counted above.
                </p>
              {/if}
              <p class="border-t border-border pt-3 text-[11px] leading-relaxed text-fg-faint">
                Earned income + asset sales + other = cash received, exactly — no event is counted twice.
                Asset sales are <span class="text-fg-muted">conversions</span>, not profit: the items left your inventory.
                {#if cr.earned.ocPayouts > 0}
                  OC payouts are credited to your faction balance (withdrawable there), not your wallet.
                {/if}
              </p>
            </div>
          {:else if topIncome.length === 0}
            <StateMessage state="empty" title="No money events in this range" />
          {:else}
            <ul class="space-y-4">
              {#each topIncome as row (row.category)}
                <li>
                  <div class="flex items-baseline justify-between gap-3 text-[13px]">
                    <span class="text-fg">
                      {incomeLabel(String(row.category))}
                      {#if isInflowConversion(String(row.category))}
                        <span class="ml-1.5 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide whitespace-nowrap text-fg-faint" title="Asset conversion: cash received for something you owned — not earnings">conversion</span>
                      {:else}
                        <span class="ml-1.5 rounded-full border border-positive/30 bg-positive/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide whitespace-nowrap text-positive" title="Earned money — raises total wealth">earned</span>
                      {/if}
                    </span>
                    <span class="tnum font-medium {isInflowConversion(String(row.category)) ? 'text-fg-muted' : 'text-positive'}">+{formatMoneyCompact(row.total)}</span>
                  </div>
                  <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div class="h-full rounded-full {isInflowConversion(String(row.category)) ? 'bg-fg-faint/50' : 'bg-positive/80'}" style="width: {Math.round((row.total / (topIncome[0]?.total || 1)) * 100)}%"></div>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </Panel>
      </div>
      <div class="lg:col-span-2">
        <Panel title="Cash spent" caption="Where cash went — true expenses and asset purchases are different things">
      {#snippet actions()}
        <a href="/economy" class="pr-4 text-xs font-medium text-accent transition-opacity hover:opacity-80">Explore →</a>
      {/snippet}
          {#if logsBlocked}
            <StateMessage state="permission" title={logsBlocked.title} hint={logsBlocked.hint} />
          {:else if topExpenses.length === 0}
            <StateMessage state="empty" title="No cash expenses in this range" />
          {:else}
            <ul class="space-y-4">
              {#each topExpenses as row (row.category)}
                <li>
                  <div class="flex items-baseline justify-between gap-3 text-[13px]">
                    <span class="text-fg">
                      {expenseLabel(String(row.category))}
                      {#if isOutflowConversion(String(row.category))}
                        <span class="ml-1.5 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-fg-faint" title="Asset purchase: value still owned in another form (items, points, stocks) — not an economic loss">asset purchase</span>
                      {:else}
                        <span class="ml-1.5 rounded-full border border-negative/30 bg-negative/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide whitespace-nowrap text-negative" title="True expense: value gone (fees, upkeep, rehab, losses)">true expense</span>
                      {/if}
                    </span>
                    <span class="tnum font-medium {isOutflowConversion(String(row.category)) ? 'text-fg-muted' : 'text-negative'}">-{formatMoneyCompact(row.total)}</span>
                  </div>
                  <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div class="h-full rounded-full {isOutflowConversion(String(row.category)) ? 'bg-fg-faint/50' : 'bg-negative/80'}" style="width: {Math.round((row.total / (topExpenses[0]?.total || 1)) * 100)}%"></div>
                  </div>
                </li>
              {/each}
            </ul>
            {#if data.financial.assetPurchases > 0}
              <p class="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-fg-faint">
                {formatMoneyCompact(data.financial.assetPurchases)} of this bought assets you still own (items, points, stocks) —
                <span class="text-fg-muted">Asset purchases</span>, not lost value. True expenses:
                {formatMoneyCompact(data.financial.trueExpense)}.
              </p>
            {/if}
          {/if}
        </Panel>
      </div>
      <div class="lg:col-span-2">
        <Panel title="Recent activity" caption="Latest entries from your timeline">
          {#snippet actions()}
            <a href="/timeline" class="text-xs font-medium text-accent transition-opacity hover:opacity-80">All →</a>
          {/snippet}
          {#if logsBlocked}
            <StateMessage state="permission" title={logsBlocked.title} hint={logsBlocked.hint} />
          {:else if data.recentTimeline.length === 0}
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
        {#if logsBlocked}
          <StateMessage state="permission" title={logsBlocked.title} hint={logsBlocked.hint} />
        {:else if !drugOption}
          <StateMessage state="empty" title="No drug events in this range" />
        {:else}
          <Chart option={drugOption} height={260} />
        {/if}
      </Panel>
      <Panel title="Faction" caption="Ranked war status and faction income" flush>
      {#snippet actions()}
        <a href="/faction" class="pr-4 text-xs font-medium text-accent transition-opacity hover:opacity-80">Open Faction →</a>
      {/snippet}
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
                    {data.faction.lastWar.result === "ongoing" ? "Ongoing" : data.faction.lastWar.result === "win" ? "Win" : data.faction.lastWar.result === "loss" ? "Loss" : "Draw"}
                  </span>
                  {/if}
              </p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Faction income</p>
              <p class="tnum mt-1 font-semibold text-positive">{formatMoneyCompact(data.faction.myPayouts)}</p>
            </div>
          </div>
          <p class="px-5 pt-3 text-xs text-fg-faint">
            {period} faction income excluding OC payouts — labelled breakdown in <a href="/faction" class="text-accent">Faction → Finance</a>.
          </p>
        {/if}
      </Panel>
      <Panel title="Crimes" caption="Attempts, success rate and value in range" flush>
        {#if logsBlocked}
          <StateMessage state="permission" title={logsBlocked.title} hint={logsBlocked.hint} />
        {:else if !data.crimes}
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
      <Panel title="Combat" caption="Outgoing attacks, outgoing wins and successful defenses in range" flush>
        {#if attacksBlocked}
          <StateMessage state="permission" title={attacksBlocked.title} hint={attacksBlocked.hint} />
        {:else if !data.combat}
          <StateMessage state="empty" title="No combat activity in this range" />
        {:else}
          <div class="grid grid-cols-3 gap-px bg-border">
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-fg">{data.combat.attacksMade}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">Outgoing attacks</p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-positive">{data.combat.outgoingWins}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">Outgoing wins</p>
            </div>
            <div class="bg-surface p-5 text-center">
              <p class="tnum text-2xl font-semibold text-positive">{data.combat.incomingDefended}</p>
              <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">Successful defenses</p>
            </div>
          </div>
          <p class="px-5 pt-3 text-xs text-fg-faint">
            {period} combat, exact from your Torn attacks record — direction is explicit so attack and defense counts never blur. <a href="/combat" class="text-accent">Explore →</a>
          </p>
        {/if}
      </Panel>
      <Panel title="Travel profit" caption="Estimated profit by departure day" flush>
        {#snippet actions()}
          <a href="/travel" class="pr-4 text-xs font-medium text-accent transition-opacity hover:opacity-80">Explore →</a>
        {/snippet}
        {#if logsBlocked}
          <StateMessage state="permission" title={logsBlocked.title} hint={logsBlocked.hint} />
        {:else if !travelOption}
          <StateMessage state="empty" title="No trips in this range" />
        {:else}
          <Chart option={travelOption} height={260} />
        {/if}
      </Panel>
    </section>
  {/if}
</div>
