<script lang="ts">
  import type { EconomySummaryResponse, MoneySummaryResponse, MoneyEventDto, Paginated } from "@tornscope/shared";
  import { MONEY_CATEGORIES, formatMoneyCompact, formatMoneyFull, formatDateTime, formatKpiValue, periodLabel, formatSignedMoney, formatDate } from "@tornscope/shared";
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
    drug: "Drugs consumed",
    booster: "Boosters",
    medical: "Medical items",
    happy_jump: "Happy items",
    energy: "Energy drinks",
    candy: "Candy",
    temporary: "Temporary items",
    drug_pack: "Drug packs (multi-item boxes)",
    other: "Other consumables",
  };

  const topConsumedValue = $derived(economy?.consumption.byCategory[0]?.totalValue || 1);

  /** Friendly cash-expense groups; the rows always sum to Cash Expenses. */
  const EXPENSE_LABELS: Record<string, string> = {
    rehab: "Rehab",
    casino: "Casino",
    items: "Item purchases",
    bazaar: "Bazaar purchases",
    plushie: "Plushies",
    flower: "Flowers",
    travel: "Travel purchases",
    points: "Points",
    stock: "Stocks",
    housing: "Property upkeep",
    crime: "Crime",
    mugging: "Mugging",
    trading: "Trades",
    auction: "Auctions",
    drugs: "Drugs",
    faction: "Faction",
    salary: "Salary",
    education: "Education",
    hospital: "Hospital",
    jail: "Jail",
    city_bank: "Bank",
  };

  const expenseBreakdown = $derived(
    (economy?.cashFlow.expensesByCategory ?? []).map((row) => ({
      label: EXPENSE_LABELS[row.category] ?? row.category,
      category: String(row.category),
      total: row.total,
    }))
  );

  /**
   * Cash received from SELLING inventory (bazaar / item market / trades /
   * auctions). Part of cash inflow by definition, but NOT economic gain:
   * the items left the inventory.
   */
  const SALES_CATEGORIES = new Set(["bazaar", "items", "trading", "auction"]);
  const soldInventoryIncome = $derived(
    (economy?.cashFlow.incomeByCategory ?? []).filter((c) => SALES_CATEGORIES.has(String(c.category))).reduce((s, c) => s + c.total, 0)
  );
  const operationalIncome = $derived(
    (economy?.cashFlow.incomeByCategory ?? []).filter((c) => !SALES_CATEGORIES.has(String(c.category))).reduce((s, c) => s + c.total, 0)
  );

  /** Cash spent on assets still owned (items, points, stocks, banks). */
  const ASSET_BUY_CATEGORIES = new Set(["bazaar", "items", "trading", "auction", "points", "stock", "travel", "plushie", "flower", "drugs"]);
  const assetPurchases = $derived(
    (economy?.cashFlow.expensesByCategory ?? []).filter((c) => ASSET_BUY_CATEGORIES.has(String(c.category))).reduce((s, c) => s + c.total, 0)
  );
  const trueExpenses = $derived(
    (economy?.cashFlow.expensesByCategory ?? []).filter((c) => !ASSET_BUY_CATEGORIES.has(String(c.category))).reduce((s, c) => s + c.total, 0)
  );

  /** Distinct pie palettes: inflow (greens/teals) vs outflow (reds/ambers). */
  const INFLOW_PALETTE = ["#2dd4bf", "#14b8a6", "#3fd68f", "#5eead4", "#8fd6c0", "#a7f3d0", "#6ee7b7", "#34d399"];
  const OUTFLOW_PALETTE = ["#f87171", "#fb923c", "#f0b24a", "#e879a0", "#d4a5a5", "#c084fc", "#fca5a5", "#fbbf24"];

  function labelledDonut(rows: Array<{ category: string; total: number }>, palette: string[], name: string) {
    const top = rows.slice(0, 8);
    return {
      tooltip: { ...TOOLTIP, trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { ...LEGEND, type: "scroll", orient: "vertical", right: 2, top: "middle", textStyle: { color: C.label, fontSize: 10.5 } },
      series: [
        {
          name,
          type: "pie",
          radius: ["48%", "72%"],
          center: ["34%", "50%"],
          label: { show: false },
          itemStyle: { borderRadius: 4, borderColor: "#151518", borderWidth: 2 },
          data: top.map((r, i) => ({ name: r.category, value: r.total, itemStyle: { color: palette[i % palette.length] } })),
        },
      ],
    };
  }

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
      legend: { ...LEGEND, data: ["Cash inflow", "Cash outflow"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(summary.flowSeries.map((p) => dayLabel(p.t))),
      yAxis: valueAxis(),
      series: [
        { name: "Cash inflow", type: "bar", data: summary.flowSeries.map((p) => p.income), barMaxWidth: 12, itemStyle: { color: C.positive, borderRadius: [3, 3, 0, 0] } },
        { name: "Cash outflow", type: "bar", data: summary.flowSeries.map((p) => -p.expenses), barMaxWidth: 12, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });
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
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">A · Cash Flow — money that moved through your wallet</h2>
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="{period} Cash Inflow" value={formatKpiValue(economy.cashFlow.income)} provenance="exact" tone="positive" sub={`earned ${formatMoneyCompact(economy.cashFlow.trueIncome)} · asset sales ${formatMoneyCompact(economy.cashFlow.assetInflow)}`} />
        <Stat label="{period} Cash Outflow" value={formatKpiValue(economy.cashFlow.expenses)} provenance="exact" tone="negative" sub={`true expenses ${formatMoneyCompact(economy.cashFlow.trueExpense)} · asset purchases ${formatMoneyCompact(economy.cashFlow.assetOutflow)}`} />
        <Stat label="{period} Net Cash Flow" value={formatKpiValue(economy.cashFlow.netCashFlow)} provenance="exact" tone={(economy.cashFlow.netCashFlow.value ?? 0) >= 0 ? "positive" : "negative"} />
        <Stat
          label="Top cash outflow"
          value={summary.largestExpenseCategory.category ?? "—"}
          sub={summary.largestExpenseCategory.total !== null ? formatMoneyCompact(summary.largestExpenseCategory.total) : null}
          provenance="exact"
        />
      </div>

      <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
        <span class="font-medium text-fg">Reading these numbers:</span>
        earned money {formatMoneyCompact(operationalIncome)} raised your wealth directly
        <span class="mx-1 text-border-strong">·</span>
        {formatMoneyCompact(soldInventoryIncome)} is asset sales (items → cash — conversion, not profit)
        <span class="mx-1 text-border-strong">·</span>
        {formatMoneyCompact(assetPurchases)} bought assets you still own (cash → items/points/stocks — conversion, not loss)
        <span class="mx-1 text-border-strong">·</span>
        {formatMoneyCompact(trueExpenses)} left for good (rehab, fees, upkeep, muggings).
      </p>

      {#if economy.sales.cashReceived > 0}
        <div class="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
          <div class="bg-surface p-5 text-center">
            <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Sold assets — cash received</p>
            <p class="tnum mt-1 text-xl font-semibold text-fg">{formatMoneyCompact(economy.sales.cashReceived)}</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Est. inventory value sold</p>
            <p class="tnum mt-1 text-xl font-semibold text-fg-muted">{economy.sales.inventoryValueRemoved !== null ? formatMoneyCompact(economy.sales.inventoryValueRemoved) : "Unavailable"}</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint" title="Cash received minus estimated catalog value of the sold items">Estimated value difference</p>
            <p class="tnum mt-1 text-xl font-semibold {((economy.sales.economicResult ?? 0) >= 0 ? 'text-positive' : 'text-negative')}">
              {economy.sales.economicResult !== null ? formatSignedMoney(economy.sales.economicResult) : "Partial"}
            </p>
          </div>
        </div>
        <p class="text-xs text-fg-faint">
          Based on current catalog value, not historical acquisition cost — so this is an
          <span class="text-fg-muted">estimated economic effect of selling, not trading profit and not a realized loss</span>.
          Item identity comes from the exact sale logs; the Net Worth Change below settles the real effect.
        </p>
      {/if}

      <Panel title="Cash outflow by category" caption="Where the Cash Outflow total goes — consumed inventory is NOT part of this">
        {#if economy.cashFlow.expensesByCategory.length === 0}
          <StateMessage state="empty" title="No cash expenses in this range" />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pr-4 font-medium">Category</th>
                  <th class="py-2.5 pr-4 font-medium">Meaning</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Cash out</th>
                  <th class="py-2.5 text-right font-medium">Share</th>
                </tr>
              </thead>
              <tbody>
                {#each expenseBreakdown as row (row.label)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2.5 pr-4 text-fg">{row.label}</td>
                    <td class="py-2.5 pr-4 text-xs">
                      {#if ASSET_BUY_CATEGORIES.has(row.category)}
                        <span class="rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-fg-faint" title="Value still owned in another form — not an economic loss">asset conversion</span>
                      {:else}
                        <span class="rounded-full border border-negative/30 bg-negative/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-negative">true expense</span>
                      {/if}
                    </td>
                    <td class="tnum py-2.5 pr-4 text-right {ASSET_BUY_CATEGORIES.has(row.category) ? 'text-fg-muted' : 'text-negative'}">{formatMoneyCompact(row.total)}</td>
                    <td class="tnum py-2.5 text-right text-fg-faint">{Math.round((row.total / (economy.cashFlow.expenses.value || 1)) * 100)}%</td>
                  </tr>
                {/each}
                <tr class="font-semibold">
                  <td class="py-2.5 pr-4 text-fg" colspan="2">Total Cash Outflow</td>
                  <td class="tnum py-2.5 pr-4 text-right text-negative">{formatMoneyCompact(economy.cashFlow.expenses.value ?? 0)}</td>
                  <td class="tnum py-2.5 text-right text-fg-faint">100%</td>
                </tr>
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>
    </section>

    <!-- ═══ B. Asset movement & consumption ═══ -->
    <section class="space-y-6">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">B · Asset Movement &amp; Consumption — value that changed form or left your inventory</h2>
      <p class="max-w-3xl text-[13px] leading-relaxed text-fg-muted">
        Purchased assets (cash → items/points/stocks) and sold assets (items → cash, in section A) are conversions — the value stays
        yours in another form. Consumed assets (below) are value used up. They are never cash expenses and never profit:
        a Xanax bought for $840k was a cash movement when bought; using it later moves value out of inventory.
      </p>
      <div class="flex flex-wrap gap-x-6 gap-y-1.5 rounded-xl border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span><span class="font-medium text-fg">Purchased assets:</span> {formatMoneyCompact(assetPurchases)}</span>
        <span><span class="font-medium text-fg">Sold assets:</span> {formatMoneyCompact(soldInventoryIncome)} cash · {economy.sales.inventoryValueRemoved !== null ? formatMoneyCompact(economy.sales.inventoryValueRemoved) : "n/a"} est. value</span>
        <span><span class="font-medium text-fg">Consumed:</span> {formatKpiValue(economy.consumption.totalValue)}</span>
        <span><span class="font-medium text-fg">Unknown inventory outflow:</span> {economy.consumption.valueUnknownCount} use{economy.consumption.valueUnknownCount === 1 ? "" : "s"} without a price</span>
      </div>
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Consumed value (est.)" value={formatKpiValue(economy.consumption.totalValue)} provenance="estimated" tone="negative" sub={economy.consumption.valueUnknownCount > 0 ? `${economy.consumption.valueUnknownCount} uses without a price` : null} />
        <Stat label="Drugs consumed" value={economy.consumption.drugValue !== null ? formatMoneyCompact(economy.consumption.drugValue) : formatKpiValue({ value: null, availability: economy.consumption.uses === 0 ? "unavailable" : "incomplete" })} provenance="estimated" tone="negative" />
        <Stat label="Inventory sold (est.)" value={economy.sales.inventoryValueRemoved !== null ? formatMoneyCompact(economy.sales.inventoryValueRemoved) : "Unavailable"} provenance="estimated" sub={`sales received ${formatMoneyCompact(economy.sales.cashReceived)}`} />
        <Stat label="Non-cash wealth gained (est.)" value={economy.nonCashGains.value !== null ? formatMoneyCompact(economy.nonCashGains.value) : "—"} provenance={economy.nonCashGains.provenance === "estimated" ? "estimated" : "exact"} sub="crime & OC item rewards only" />
      </div>

      <Panel title="Consumed inventory by category" caption="Items USED UP — valued from Torn catalog market prices at use time">
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

    <!-- ═══ C. Wealth effects ═══ -->
    <section class="space-y-6">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">C · Wealth Effects — what actually happened to your total wealth</h2>
      {#if economy.networth.trackingSince !== null}
        <p class="text-xs text-fg-faint">Tracking since {formatDate(economy.networth.trackingSince)} — net worth history before that point does not exist and is never fabricated.</p>
      {/if}
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Current net worth" value={formatKpiValue(economy.networth.current)} provenance="exact" tone="accent" />
        <Stat
          label="Net Worth Change{economy.networth.coverage === 'partial' ? ' (partial)' : ''}"
          value={economy.networth.coverage === "none" ? "Insufficient history" : formatSignedMoney(economy.networth.change.value)}
          provenance="exact"
          tone={(economy.networth.change.value ?? 0) >= 0 ? "positive" : "negative"}
          sub={economy.networth.coverage === "partial" && economy.networth.baselineAt !== null ? `snapshots ${formatDate(economy.networth.baselineAt)} → ${economy.networth.currentAt !== null ? formatDate(economy.networth.currentAt) : "now"} — partial coverage of range` : economy.networth.changePct !== null ? `${economy.networth.changePct >= 0 ? "+" : ""}${economy.networth.changePct.toFixed(2)}%` : null}
        />
        <Stat label="Estimated Travel Profit" value={formatKpiValue(economy.travel.estimatedProfit)} provenance="estimated" tone={(economy.travel.estimatedProfit.value ?? 0) >= 0 ? "positive" : "negative"} />
        <Stat label="Travel profit / hour" value={formatKpiValue(economy.travel.profitPerHour)} provenance="estimated" sub={economy.travel.trips > 0 ? `${economy.travel.trips} trip${economy.travel.trips === 1 ? "" : "s"}` : null} />
      </div>
      <p class="text-xs text-fg-faint">
        Net Worth Change is the snapshot delta from official Torn net worth — it includes item/stock/property price moves as well as
        spending and income, so it is a wealth movement, not “profit”. Estimated economic effects (travel profit, sale value
        difference) are shown separately above and are never merged into it.
      </p>

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
      <Panel title="Cash inflow vs outflow" caption="Per-day cash movement in both directions" flush>
        {#if !flowOption}
          <StateMessage state="empty" title="No flow to show" />
        {:else}
          <Chart option={flowOption} height={280} />
        {/if}
      </Panel>
      <Panel title="Inflow vs outflow mix" caption="Distinct palettes + legend: inflow categories (left) vs outflow categories (right)">
        {#if summary.incomeByCategory.length === 0 && summary.expensesByCategory.length === 0}
          <StateMessage state="empty" title="No categories to break down" />
        {:else}
          <div class="grid grid-cols-2 gap-4">
            <div>
              <Chart option={labelledDonut(summary.incomeByCategory, INFLOW_PALETTE, "Cash inflow")} height={220} />
              <p class="mt-1 text-center text-[11px] uppercase tracking-[0.14em] text-positive">Cash inflow</p>
            </div>
            <div>
              <Chart option={labelledDonut(summary.expensesByCategory, OUTFLOW_PALETTE, "Cash outflow")} height={220} />
              <p class="mt-1 text-center text-[11px] uppercase tracking-[0.14em] text-negative">Cash outflow</p>
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
          <option value="income">Cash in</option>
          <option value="expense">Cash out</option>
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
