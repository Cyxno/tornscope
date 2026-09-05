<script lang="ts">
  import type { EconomySummaryResponse, MoneySummaryResponse, MoneyEventDto, Paginated } from "@tornscope/shared";
  import { MONEY_CATEGORIES, formatMoneyCompact, formatMoneyFull, formatDateTime, formatKpiValue, periodLabel, formatSignedMoney } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel, tealArea } from "$lib/charts";

  let economy = $state<EconomySummaryResponse | null>(null);
  let summary = $state<MoneySummaryResponse | null>(null);
  let events = $state<Paginated<MoneyEventDto> | null>(null);
  let loading = $state(true);
  let eventsLoading = $state(false);
  let error = $state<string | null>(null);
  let eventsError = $state<string | null>(null);
  let reloadToken = $state(0);

  let category = $state("");
  let direction = $state("");
  let search = $state("");

  async function loadSummary() {
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const [eco, money] = await Promise.all([endpoints.economy(range), endpoints.moneySummary(range)]);
      economy = eco;
      summary = money;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    }
  }

  async function loadEvents(append = false) {
    eventsLoading = true;
    eventsError = null;
    try {
      const result = await endpoints.moneyEvents(
        { preset: dateRange.preset, from: dateRange.from, to: dateRange.to },
        { limit: 50, category: category || undefined, direction: direction || undefined, search: search || undefined }
      );
      events = append && events ? { items: [...events.items, ...result.items], nextCursor: result.nextCursor } : result;
    } catch (err) {
      eventsError = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      eventsLoading = false;
      loading = false;
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  function onSearchInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void loadEvents(false), 350);
  }

  $effect(() => {
    void dateRange.preset;
    void dateRange.from;
    void reloadToken;
    void category;
    void direction;
    void loadSummary();
    void loadEvents(false);
  });

  const period = $derived(periodLabel(dateRange.preset));

  const CONSUMPTION_LABELS: Record<string, string> = {
    drug: "Drugs",
    booster: "Boosters",
    medical: "Medical",
    happy_jump: "Happy items",
    energy: "Energy drinks",
    candy: "Candy",
    temporary: "Temporary items",
    other: "Other",
  };

  const topConsumedValue = $derived(economy?.consumption.byCategory[0]?.totalValue || 1);

  const cumulativeOption = $derived.by(() => {
    if (!summary || summary.cumulativeNetSeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: { ...GRID, top: 20 },
      xAxis: timeAxis(summary.cumulativeNetSeries.map((p) => dayLabel(p.t))),
      yAxis: valueAxis(),
      series: [
        {
          name: "Cumulative net cash flow",
          type: "line",
          data: summary.cumulativeNetSeries.map((p) => p.net),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: C.accent, width: 2 },
          areaStyle: tealArea(),
        },
      ],
    };
  });

  const flowOption = $derived.by(() => {
    if (!summary || summary.flowSeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: ["Income", "Expenses"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(summary.flowSeries.map((p) => dayLabel(p.t))),
      yAxis: valueAxis(),
      series: [
        { name: "Income", type: "bar", data: summary.flowSeries.map((p) => p.income), barMaxWidth: 12, itemStyle: { color: C.positive, borderRadius: [3, 3, 0, 0] } },
        { name: "Expenses", type: "bar", data: summary.flowSeries.map((p) => -p.expenses), barMaxWidth: 12, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });

  function networthChangeLabel(): string {
    if (!economy) return "Networth Change";
    return economy.networth.coverage === "partial" ? "Tracked period change" : `${period} Networth Change`;
  }

  function donut(rows: Array<{ category: string; total: number }>, color: string) {
    const top = rows.slice(0, 6);
    return {
      tooltip: { ...TOOLTIP, trigger: "item", formatter: "{b}: {c} ({d}%)" },
      series: [
        {
          type: "pie",
          radius: ["56%", "80%"],
          center: ["50%", "50%"],
          label: { show: false },
          itemStyle: { borderRadius: 4, borderColor: "#151518", borderWidth: 2 },
          data: top.map((r) => ({ name: r.category, value: r.total, itemStyle: { color } })),
        },
      ],
    };
  }
</script>

<div class="space-y-10">
  <PageHeader
    eyebrow="Finance"
    title="Economy"
    description="Cash flow, consumed value and networth change — three separate concepts, never merged into one number."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && (!summary || !economy)}
    <StateMessage state="loading" />
  {:else if error && !summary}
    <StateMessage state="error" title="Could not load economy analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if summary && economy}
    <!-- ═══ A. Cash flow ═══ -->
    <section class="space-y-6">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">A · Cash Flow — real money in and out</h2>
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="{period} income" value={formatKpiValue(economy.cashFlow.income)} provenance="exact" tone="positive" sub={economy.cashFlow.unclassifiedCount > 0 ? `${economy.cashFlow.unclassifiedCount} unclassified` : null} />
        <Stat label="{period} expenses" value={formatKpiValue(economy.cashFlow.expenses)} provenance="exact" tone="negative" sub={economy.cashFlow.unclassifiedCount > 0 ? `${economy.cashFlow.unclassifiedCount} unclassified` : null} />
        <Stat label="{period} Net Cash Flow" value={formatKpiValue(economy.cashFlow.netCashFlow)} provenance="exact" tone={(economy.cashFlow.netCashFlow.value ?? 0) >= 0 ? "positive" : "negative"} />
        <Stat
          label="Top expense"
          value={summary.largestExpenseCategory.category ?? "—"}
          sub={summary.largestExpenseCategory.total !== null ? formatMoneyCompact(summary.largestExpenseCategory.total) : null}
          provenance="exact"
        />
      </div>
    </section>

    <!-- ═══ B. Consumption ═══ -->
    <section class="space-y-6">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">B · Consumption — value of items used up (not cash flow)</h2>
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Total Consumed Value" value={formatKpiValue(economy.consumption.totalValue)} provenance="estimated" tone="negative" sub={economy.consumption.valueUnknownCount > 0 ? `${economy.consumption.valueUnknownCount} uses without a price` : null} />
        <Stat label="Drug consumption" value={economy.consumption.drugValue !== null ? formatMoneyCompact(economy.consumption.drugValue) : formatKpiValue({ value: null, availability: economy.consumption.uses === 0 ? "unavailable" : "incomplete" })} provenance="estimated" tone="negative" />
        <Stat label="Consumption events" value={String(economy.consumption.uses)} provenance="exact" />
        <Stat label="{period} Networth Change" value={economy.networth.coverage === "none" ? "Insufficient history" : formatSignedMoney(economy.networth.change.value)} provenance="exact" tone={(economy.networth.change.value ?? 0) >= 0 ? "positive" : "negative"} sub={networthChangeLabel() !== `${period} Networth Change` ? "incomplete history for this period" : (economy.networth.changePct !== null ? `${economy.networth.changePct >= 0 ? "+" : ""}${economy.networth.changePct.toFixed(2)}%` : null)} />
      </div>

      <Panel title="Consumed value by category" caption="What your item use cost you — valued from Torn catalog market prices">
        {#if economy.consumption.byCategory.length === 0}
          <StateMessage state="empty" title="No consumption recorded in this range" hint="Item uses appear here as the sync collects logs." />
        {:else}
          <ul class="space-y-4">
            {#each economy.consumption.byCategory as row (row.category)}
              <li>
                <div class="flex items-baseline justify-between gap-3 text-[13px]">
                  <span class="text-fg">
                    {CONSUMPTION_LABELS[row.category] ?? row.category}
                    <span class="ml-1.5 text-[11px] text-fg-faint">{row.uses} use{row.uses === 1 ? "" : "s"}</span>
                  </span>
                  <span class="tnum font-medium text-negative">
                    {row.totalValue !== null ? `-${formatMoneyCompact(row.totalValue).replace("-", "")}` : "Incomplete"}
                  </span>
                </div>
                <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div class="h-full rounded-full bg-negative/70" style="width: {row.totalValue !== null ? Math.round((row.totalValue / topConsumedValue) * 100) : 0}%"></div>
                </div>
              </li>
            {/each}
          </ul>
          {#if economy.consumption.valueUnknownCount > 0}
            <p class="mt-4 text-[11px] text-fg-faint">
              {economy.consumption.valueUnknownCount} use{economy.consumption.valueUnknownCount === 1 ? "" : "s"} without a known price are counted as uses but add nothing to Consumed Value — never an invented price.
            </p>
          {/if}
        {/if}
      </Panel>
    </section>

    <!-- ═══ C. Networth ═══ -->
    <section class="space-y-6">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">C · Networth — Torn snapshots, including inventory appreciation</h2>
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Current networth" value={formatKpiValue(economy.networth.current)} provenance="exact" tone="accent" />
        <Stat
          label={networthChangeLabel()}
          value={economy.networth.coverage === "none" ? "Insufficient history" : formatSignedMoney(economy.networth.change.value)}
          provenance="exact"
          tone={(economy.networth.change.value ?? 0) >= 0 ? "positive" : "negative"}
          sub={economy.networth.changePct !== null ? `${economy.networth.changePct >= 0 ? "+" : ""}${economy.networth.changePct.toFixed(2)}%` : null}
        />
        <Stat label="Estimated Travel Profit" value={formatKpiValue(economy.travel.estimatedProfit)} provenance="estimated" tone={(economy.travel.estimatedProfit.value ?? 0) >= 0 ? "positive" : "negative"} />
        <Stat label="Travel profit / hour" value={formatKpiValue(economy.travel.profitPerHour)} provenance="estimated" sub={economy.travel.trips > 0 ? `${economy.travel.trips} trip${economy.travel.trips === 1 ? "" : "s"}` : null} />
      </div>

      {#if economy.networth.byCategory.length > 0}
        <Panel title="Networth by category" caption="Torn-provided categories — baseline is the closest snapshot at or before the period start">
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pr-4 font-medium">Category</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Baseline</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Current</th>
                  <th class="py-2.5 text-right font-medium">{period} change</th>
                </tr>
              </thead>
              <tbody>
                {#each economy.networth.byCategory as cat (cat.key)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2.5 pr-4 text-fg">{cat.label}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{formatMoneyCompact(cat.baseline)}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{formatMoneyCompact(cat.current)}</td>
                    <td class="tnum py-2.5 text-right font-medium {cat.change >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedMoney(cat.change)}</td>
                  </tr>
                {/each}
                <tr class="font-semibold">
                  <td class="py-2.5 pr-4 text-fg">Total</td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg">{formatMoneyCompact(economy.networth.baseline ?? 0)}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg">{formatMoneyCompact(economy.networth.current.value ?? 0)}</td>
                  <td class="tnum py-2.5 text-right {economy.networth.change.value !== null && economy.networth.change.value < 0 ? 'text-negative' : 'text-positive'}">
                    {economy.networth.coverage === "none" ? "Insufficient history" : formatSignedMoney(economy.networth.change.value)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {#if economy.networth.coverage === "partial"}
            <p class="mt-4 text-[11px] text-fg-faint">Tracked period: TornScope started snapshotting after this period began, so the change covers the tracked span only.</p>
          {/if}
        </Panel>
      {/if}
    </section>

    <!-- Cash flow charts -->
    <Panel title="Cumulative net cash flow" caption="Running cash flow across the selected range" flush>
      {#if !cumulativeOption}
        <StateMessage state="empty" title="No money events in this range" />
      {:else}
        <Chart option={cumulativeOption} height={320} />
      {/if}
    </Panel>

    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Income vs expenses" caption="Per-day cash flow in both directions" flush>
        {#if !flowOption}
          <StateMessage state="empty" title="No flow to show" />
        {:else}
          <Chart option={flowOption} height={280} />
        {/if}
      </Panel>
      <Panel title="Balance of categories" caption="Income share (teal) vs expense share (red)">
        {#if summary.incomeByCategory.length === 0 && summary.expensesByCategory.length === 0}
          <StateMessage state="empty" title="No categories to break down" />
        {:else}
          <div class="grid grid-cols-2 gap-4">
            <div>
              <Chart option={donut(summary.incomeByCategory, C.positive)} height={200} />
              <p class="mt-1 text-center text-[11px] uppercase tracking-[0.14em] text-fg-faint">Income</p>
            </div>
            <div>
              <Chart option={donut(summary.expensesByCategory, C.negative)} height={200} />
              <p class="mt-1 text-center text-[11px] uppercase tracking-[0.14em] text-fg-faint">Expenses</p>
            </div>
          </div>
        {/if}
      </Panel>
    </section>

    <!-- Ledger -->
    <Panel title="The cash ledger" caption="Every real cash movement recorded from Torn logs — deduplicated, exact amounts">
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <select bind:value={category} class="rounded-full border border-border bg-bg-raise px-3.5 py-2 text-xs text-fg">
          <option value="">All categories</option>
          {#each MONEY_CATEGORIES as cat (cat)}
            <option value={cat}>{cat}</option>
          {/each}
        </select>
        <select bind:value={direction} class="rounded-full border border-border bg-bg-raise px-3.5 py-2 text-xs text-fg">
          <option value="">In & out</option>
          <option value="income">Income</option>
          <option value="expense">Expense</option>
        </select>
        <input
          placeholder="Search description…"
          bind:value={search}
          oninput={onSearchInput}
          class="w-52 rounded-full border border-border bg-bg-raise px-4 py-2 text-xs text-fg placeholder:text-fg-faint focus:border-accent"
        />
      </div>

      {#if eventsError}
        <StateMessage state="error" title="Could not load ledger" hint={eventsError} action={{ label: "Retry", run: () => void loadEvents(false) }} />
      {:else if !events || (events.items.length === 0 && !eventsLoading)}
        <StateMessage state="empty" title="No ledger entries match" hint="Loosen the filters, or wait for the next sync." />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2.5 pr-4 font-medium">Date</th>
                <th class="py-2.5 pr-4 font-medium">Category</th>
                <th class="py-2.5 pr-4 font-medium">Description</th>
                <th class="py-2.5 pr-4 text-right font-medium">In</th>
                <th class="py-2.5 text-right font-medium">Out</th>
              </tr>
            </thead>
            <tbody>
              {#each events.items as event (event.id)}
                <tr class="border-b border-border/50 transition-colors last:border-0 hover:bg-surface-2/50">
                  <td class="tnum whitespace-nowrap py-2.5 pr-4 text-xs text-fg-faint">{formatDateTime(event.occurredAt)}</td>
                  <td class="py-2.5 pr-4">
                    <span class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] capitalize text-fg-muted">{event.category}</span>
                  </td>
                  <td class="max-w-[360px] truncate py-2.5 pr-4 text-fg" title={event.description ?? ""}>{event.description ?? event.subcategory ?? "—"}</td>
                  <td class="tnum py-2.5 pr-4 text-right font-medium {event.direction === 'income' ? 'text-positive' : 'text-fg-faint'}">
                    {event.direction === "income" ? formatMoneyFull(event.amount) : ""}
                  </td>
                  <td class="tnum py-2.5 text-right font-medium {event.direction === 'expense' ? 'text-negative' : 'text-fg-faint'}">
                    {event.direction === "expense" ? formatMoneyFull(-event.amount) : ""}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="mt-4 flex justify-center">
          {#if eventsLoading}
            <div class="h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-accent"></div>
          {:else if events.nextCursor}
            <button class="rounded-full border border-border-strong px-5 py-2 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent" onclick={() => void loadEvents(true)}>
              Load more
            </button>
          {/if}
        </div>
      {/if}
    </Panel>
  {/if}
</div>
