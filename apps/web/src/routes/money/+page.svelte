<script lang="ts">
  import type { MoneySummaryResponse, MoneyEventDto, Paginated } from "@tornscope/shared";
  import { MONEY_CATEGORIES, formatMoneyCompact, formatMoneyFull, formatDateTime } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel, tealArea } from "$lib/charts";

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
      summary = await endpoints.moneySummary({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to });
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

  const cumulativeOption = $derived.by(() => {
    if (!summary) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: { ...GRID, top: 20 },
      xAxis: timeAxis(summary.cumulativeNetSeries.map((p) => dayLabel(p.t))),
      yAxis: valueAxis(),
      series: [
        {
          name: "Cumulative net",
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
    if (!summary) return null;
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
    title="Money flow"
    description="Every dollar in and out of your Torn life — one deduplicated ledger, exact amounts, honest categories."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !summary}
    <StateMessage state="loading" />
  {:else if error && !summary}
    <StateMessage state="error" title="Could not load money analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if summary}
    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
      <Stat label="Income" value={formatMoneyCompact(summary.totalIncome.value)} provenance="exact" tone="positive" />
      <Stat label="Expenses" value={formatMoneyCompact(summary.totalExpenses.value)} provenance="exact" tone="negative" />
      <Stat label="Net result" value={formatMoneyCompact(summary.netProfit.value)} provenance="exact" tone={(summary.netProfit.value ?? 0) >= 0 ? "positive" : "negative"} />
      <Stat
        label="Top expense"
        value={summary.largestExpenseCategory.category ?? "—"}
        sub={summary.largestExpenseCategory.total !== null ? formatMoneyCompact(summary.largestExpenseCategory.total) : null}
        provenance="exact"
      />
    </div>

    <Panel title="Cumulative net result" caption="Running profit across the selected range" flush>
      {#if !cumulativeOption}
        <StateMessage state="empty" title="No money events in this range" />
      {:else}
        <Chart option={cumulativeOption} height={320} />
      {/if}
    </Panel>

    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Income vs expenses" caption="Per-day flow in both directions" flush>
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
    <Panel title="The ledger" caption="Every money event recorded from Torn logs — deduplicated, exact amounts">
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
