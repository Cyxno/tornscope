<script lang="ts">
  import type { EconomySummaryResponse, MoneySummaryResponse, MoneyEventDto, Paginated } from "@tornscope/shared";
  import { MONEY_CATEGORIES, formatMoneyCompact, formatMoneyFull, formatDateTime, formatKpiValue, periodLabel, formatSignedMoney, formatSignedMoneyCompact, formatDate } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { incomeLabel, expenseLabel, humanLabel } from "@tornscope/shared";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel, tealArea, MOTION, CHART_SURFACE } from "$lib/charts";

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

  // Permission-aware sections: unavailable data must never render as zeros.
  const cashAv = $derived(economy?.availability?.cashFlow);
  const cashBlocked = $derived(cashAv !== undefined && !availabilityHasData(cashAv));
  const cashStale = $derived(cashAv && cashAv.state === "stale_permission" ? availabilityMessage(cashAv) : null);
  const nwAv = $derived(economy?.availability?.networth);
  const nwBlocked = $derived(nwAv !== undefined && !availabilityHasData(nwAv));

  const CONSUMPTION_LABELS: Record<string, string> = {
    drug: "Drugs consumed",
    booster: "Boosters",
    medical: "Medical items",
    happy_jump: "Happy items",
    energy: "Energy drinks",
    candy: "Candy",
    temporary: "Temporary items",
    drug_pack: "Drug Packs (each converts into drugs, valued when used)",
    other: "Other consumables",
  };

  const topConsumedValue = $derived(economy?.consumption.byCategory[0]?.totalValue || 1);

  const expenseBreakdown = $derived(
    (economy?.cashFlow.expensesByCategory ?? []).map((row) => ({
      label: expenseLabel(String(row.category)),
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
  const INFLOW_PALETTE = ["#2dd4bf", "#14b8a6", "#3fd68f", "#5eead4", "#8fd6c0", "#a7f3d0"];
  const OUTFLOW_PALETTE = ["#f87171", "#fb923c", "#f0b24a", "#e879a0", "#d4a5a5", "#c084fc"];
  const DONUT_TOP_N = 5;

  /**
   * Slice categories into top-N + "Everything else", with the EXACT colors
   * the donut uses so the external legend always matches the graphic.
   */
  function donutSlices(rows: Array<{ category: string; total: number }>, palette: string[], labeler: (category: string) => string) {
    const total = rows.reduce((s, r) => s + r.total, 0) || 1;
    const top = rows.slice(0, DONUT_TOP_N);
    const rest = rows.slice(DONUT_TOP_N);
    const slices = top.map((r, i) => ({
      name: labeler(r.category),
      value: r.total,
      color: palette[i % palette.length]!,
      share: r.total / total,
    }));
    if (rest.length > 0) {
      slices.push({
        name: `Everything else (${rest.length})`,
        value: rest.reduce((s, r) => s + r.total, 0),
        color: "#4b5563",
        share: rest.reduce((s, r) => s + r.total, 0) / total,
      });
    }
    return slices;
  }

  /** Compact donut: NO in-chart legend — the legend is rendered as HTML below. */
  function donutOption(slices: Array<{ name: string; value: number; color: string }>, name: string) {
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "item", formatter: "{b}: {c} ({d}%)" },
      series: [
        {
          name,
          type: "pie",
          radius: ["56%", "80%"],
          center: ["50%", "50%"],
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderRadius: 4, borderColor: CHART_SURFACE, borderWidth: 2 },
          data: slices.map((s) => ({ name: s.name, value: s.value, itemStyle: { color: s.color } })),
        },
      ],
    };
  }

  const receivedSlices = $derived(donutSlices(summary?.incomeByCategory ?? [], INFLOW_PALETTE, incomeLabel));
  const spentSlices = $derived(donutSlices(summary?.expensesByCategory ?? [], OUTFLOW_PALETTE, expenseLabel));
  const receivedDonut = $derived(receivedSlices.length > 0 ? donutOption(receivedSlices, "Cash received") : null);
  const spentDonut = $derived(spentSlices.length > 0 ? donutOption(spentSlices, "Cash spent") : null);

  const cumulativeOption = $derived.by(() => {
    if (!summary || summary.cumulativeNetSeries.length === 0) return null;
    return {
      ...MOTION,
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
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: ["Cash received", "Cash spent"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(summary.flowSeries.map((p) => dayLabel(p.t)), { boundaryGap: true }),
      yAxis: valueAxis(),
      series: [
        { name: "Cash received", type: "bar", data: summary.flowSeries.map((p) => p.income), barMaxWidth: 12, itemStyle: { color: C.positive, borderRadius: [3, 3, 0, 0] } },
        { name: "Cash spent", type: "bar", data: summary.flowSeries.map((p) => -p.expenses), barMaxWidth: 12, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });
</script>

<svelte:head><title>Economy · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
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
    <section class="space-y-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">A</span> Cash received &amp; spent — money that moved through your wallet</h2>
        <!-- Semantic legend: the vocabulary the whole page uses -->
        <div class="flex flex-wrap gap-1.5">
          <span class="chip chip-positive !text-[10px]" title="Earned money — raises total wealth">earned</span>
          <span class="chip chip-quiet !border-border !text-[10px]" title="A conversion: value changing form, not gain or loss">conversion</span>
          <span class="chip chip-negative !text-[10px]" title="True expense — value gone">true expense</span>
        </div>
      </div>
      {#if cashBlocked && cashAv}
        <!-- Cash flow needs User Logs: a permission state, never $0 -->
        <StateMessage
          state={availabilityMessage(cashAv).state}
          title={availabilityMessage(cashAv).title}
          hint={availabilityMessage(cashAv).hint}
          action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
        />
      {:else}
      {#if cashStale}
        <p class="rounded-tile border border-warning/30 bg-warning/5 px-5 py-3 text-xs leading-relaxed text-warning">
          <span class="font-medium">{cashStale.title}.</span>
          {cashStale.hint}
        </p>
      {/if}
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="{period} Cash received" value={formatKpiValue(economy.cashFlow.income)} provenance="exact" tone="positive" confidence={economy.confidence?.cashFlow} sub={`earned ${formatMoneyCompact(economy.cashFlow.trueIncome)} · asset sales ${formatMoneyCompact(economy.cashFlow.assetInflow)}`} />
        <Stat label="{period} Cash spent" value={formatKpiValue(economy.cashFlow.expenses)} provenance="exact" tone="negative" confidence={economy.confidence?.cashFlow} sub={`true expenses ${formatMoneyCompact(economy.cashFlow.trueExpense)} · asset purchases ${formatMoneyCompact(economy.cashFlow.assetOutflow)}`} />
        <Stat
          label="{period} Net cash flow"
          value={formatKpiValue(economy.cashFlow.netCashFlow)}
          provenance="exact"
          confidence={economy.confidence?.cashFlow}
          tone={economy.cashFlow.netCashFlow.value === null ? "neutral" : economy.cashFlow.netCashFlow.value >= 0 ? "positive" : "negative"}
        />
        <Stat
          label="Top cash outflow"
          value={summary.largestExpenseCategory.category ? expenseLabel(String(summary.largestExpenseCategory.category)) : "—"}
          sub={summary.largestExpenseCategory.total !== null ? formatMoneyCompact(summary.largestExpenseCategory.total) : null}
          provenance="exact"
        />
      </div>

      <details class="group rounded-tile border border-border bg-surface px-5 py-3">
        <summary class="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
          Reading these numbers
          <span class="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <p class="mt-2.5 border-t border-border pt-2.5 text-xs leading-relaxed text-fg-muted">
          Earned money {formatMoneyCompact(operationalIncome)} raised your wealth directly
          <span class="mx-1 text-border-strong">·</span>
          {formatMoneyCompact(soldInventoryIncome)} is asset sales (items → cash — conversion, not profit)
          <span class="mx-1 text-border-strong">·</span>
          {formatMoneyCompact(assetPurchases)} bought assets you still own (cash → items/points/stocks — conversion, not loss)
          <span class="mx-1 text-border-strong">·</span>
          {formatMoneyCompact(trueExpenses)} left for good (rehab, fees, upkeep, muggings).
        </p>
      </details>

      {#if economy.sales.cashReceived > 0}
        <div class="grid grid-cols-1 gap-px overflow-hidden rounded-tile border border-border bg-border md:grid-cols-3">
          <div class="bg-surface p-4 sm:p-5">
            <p class="text-[11px] font-medium text-fg-faint">Sale proceeds <span class="uppercase tracking-wide">(cash received)</span></p>
            <p class="tnum mt-1 text-xl font-semibold text-fg">{formatMoneyCompact(economy.sales.cashReceived)}</p>
          </div>
          <div class="bg-surface p-4 sm:p-5">
            <p class="text-[11px] font-medium text-fg-faint">Estimated item value sold</p>
            <p class="tnum mt-1 text-xl font-semibold text-fg-muted">{economy.sales.inventoryValueRemoved !== null ? formatMoneyCompact(economy.sales.inventoryValueRemoved) : "Unavailable"}</p>
          </div>
          <div class="bg-surface p-4 sm:p-5">
            <p class="text-[11px] font-medium text-fg-faint" title="Sale proceeds minus estimated catalog value of the sold items. Not called profit: acquisition cost is not reliably known.">Estimated value difference</p>
            <p class="tnum mt-1 text-xl font-semibold {economy.sales.economicResult === null ? 'text-fg-faint' : economy.sales.economicResult >= 0 ? 'text-positive' : 'text-negative'}">
              {economy.sales.economicResult !== null ? formatSignedMoneyCompact(economy.sales.economicResult) : "Partial"}
            </p>
          </div>
        </div>
      {/if}

      <Panel title="Cash spent by category" caption="Buying inventory is an asset purchase — using it later is consumption (section B), never the same accounting event">
        {#if economy.cashFlow.expensesByCategory.length === 0}
          <StateMessage state="empty" compact title="No cash expenses in this range" />
        {:else}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Meaning</th>
                  <th class="text-right">Cash out</th>
                  <th class="text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {#each expenseBreakdown as row (row.label)}
                  <tr>
                    <td class="text-fg">{row.label}</td>
                    <td>
                      {#if ASSET_BUY_CATEGORIES.has(row.category)}
                        <span class="chip chip-quiet !border-border !px-1.5 !text-[9px] !uppercase" title="Value still owned in another form — not an economic loss">asset conversion</span>
                      {:else}
                        <span class="chip chip-negative !px-1.5 !text-[9px] !uppercase">true expense</span>
                      {/if}
                    </td>
                    <td class="tnum text-right {ASSET_BUY_CATEGORIES.has(row.category) ? 'text-fg-muted' : 'text-negative'}">{formatMoneyCompact(row.total)}</td>
                    <td class="tnum text-right text-fg-faint">{Math.round((row.total / (economy.cashFlow.expenses.value || 1)) * 100)}%</td>
                  </tr>
                {/each}
                <tr class="font-semibold [&>td]:border-t [&>td]:border-border">
                  <td colspan="2" class="text-fg">Total cash spent</td>
                  <td class="tnum text-right text-negative">{economy.cashFlow.expenses.value !== null ? formatMoneyCompact(economy.cashFlow.expenses.value) : "—"}</td>
                  <td class="tnum text-right text-fg-faint">100%</td>
                </tr>
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>
      {/if}
    </section>

    <!-- ═══ B. Asset movement & consumption ═══ -->
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">B</span> Asset movement &amp; consumption — value that changed form or left your inventory</h2>
      <details class="group rounded-tile border border-border bg-surface px-5 py-3">
        <summary class="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
          How purchases, sales and consumption differ
          <span class="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <p class="mt-2.5 border-t border-border pt-2.5 text-xs leading-relaxed text-fg-muted">
          Purchased assets (cash → items/points/stocks) and sold assets (items → cash, in section A) are conversions — the value stays
          yours in another form. Consumed assets are value used up. They are never cash expenses and never profit:
          a Xanax bought for $840k was a cash movement when bought; using it later moves value out of inventory.
        </p>
      </details>
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Consumed value (est.)" value={formatKpiValue(economy.consumption.totalValue)} provenance="estimated" tone="negative" confidence={economy.confidence?.consumption} sub={economy.consumption.valueUnknownCount > 0 ? `${economy.consumption.valueUnknownCount} uses without a price` : null} />
        <Stat label="Drugs consumed" value={economy.consumption.drugValue !== null ? formatMoneyCompact(economy.consumption.drugValue) : formatKpiValue({ value: null, availability: economy.consumption.uses === 0 ? "unavailable" : "incomplete" })} provenance="estimated" tone="negative" confidence={economy.confidence?.consumption} />
        <Stat label="Inventory sold (est.)" value={economy.sales.inventoryValueRemoved !== null ? formatMoneyCompact(economy.sales.inventoryValueRemoved) : "Unavailable"} provenance="estimated" confidence={economy.confidence?.cashFlow} sub={`sales received ${formatMoneyCompact(economy.sales.cashReceived)}`} />
        <Stat label="Non-cash wealth gained (est.)" value={economy.nonCashGains.value !== null ? formatMoneyCompact(economy.nonCashGains.value) : "—"} provenance={economy.nonCashGains.provenance === "estimated" ? "estimated" : "exact"} sub="crime & OC item rewards only" />
      </div>

      <Panel title="Consumed inventory by category" caption="Items USED UP — valued from Torn catalog market prices at use time">
        {#if economy.consumption.byCategory.length === 0}
          <StateMessage state="empty" compact title="No consumption recorded in this range" hint="Item uses appear here as the sync collects logs." />
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
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">C</span> Wealth effects — what actually happened to your total wealth</h2>
      {#if nwBlocked && nwAv}
        <StateMessage
          state={availabilityMessage(nwAv).state}
          title={availabilityMessage(nwAv).title}
          hint={nwAv.state === "unavailable_permission" ? "Your current API key does not include User Networth — grant it in Torn to track wealth history." : availabilityMessage(nwAv).hint}
          action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
        />
      {:else}
      {#if economy.networth.trackingSince !== null}
        <p class="text-xs text-fg-faint">Tracking since {formatDate(economy.networth.trackingSince)} — net worth history before that point does not exist and is never fabricated.</p>
      {/if}
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Current net worth" value={formatKpiValue(economy.networth.current)} provenance="exact" tone="accent" confidence={economy.confidence?.networth} />
        <Stat
          label="Net worth change{economy.networth.coverage === 'partial' ? ' (partial)' : ''}"
          value={economy.networth.coverage === "none" ? "Insufficient history" : formatSignedMoneyCompact(economy.networth.change.value)}
          provenance="exact"
          confidence={economy.confidence?.networth}
          tone={economy.networth.change.value === null || economy.networth.coverage === "none" ? "neutral" : economy.networth.change.value >= 0 ? "positive" : "negative"}
          sub={economy.networth.coverage === "partial" && economy.networth.baselineAt !== null ? `snapshots ${formatDate(economy.networth.baselineAt)} → ${economy.networth.currentAt !== null ? formatDate(economy.networth.currentAt) : "now"} — partial coverage of range` : economy.networth.changePct !== null ? `${economy.networth.changePct >= 0 ? "+" : ""}${economy.networth.changePct.toFixed(2)}%` : null}
        />
        <Stat
          label="Estimated travel profit"
          value={formatKpiValue(economy.travel.estimatedProfit)}
          provenance="estimated"
          confidence={economy.confidence?.travel}
          tone={economy.travel.estimatedProfit.value === null ? "neutral" : economy.travel.estimatedProfit.value >= 0 ? "positive" : "negative"}
        />
        <Stat label="Travel profit / hour" value={formatKpiValue(economy.travel.profitPerHour)} provenance="estimated" confidence={economy.confidence?.travel} sub={economy.travel.trips > 0 ? `${economy.travel.trips} trip${economy.travel.trips === 1 ? "" : "s"}` : null} />
      </div>
      <details class="group rounded-tile border border-border bg-surface px-5 py-3">
        <summary class="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
          Why net worth change is not profit
          <span class="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <p class="mt-2.5 border-t border-border pt-2.5 text-xs leading-relaxed text-fg-muted">
          Net Worth Change is the snapshot delta from official Torn net worth — it includes item/stock/property price moves as well as
          spending and income, so it is a wealth movement, not “profit”. Estimated economic effects (travel profit, sale value
          difference) are shown separately above and are never merged into it.
        </p>
      </details>

      {#if economy.networth.byCategory.length > 0}
        <Panel title="Networth by category" caption="Torn-provided categories — baseline is the closest snapshot at or before the period start">
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th class="text-right">Baseline</th>
                  <th class="text-right">Current</th>
                  <th class="text-right">{period} change</th>
                </tr>
              </thead>
              <tbody>
                {#each economy.networth.byCategory as cat (cat.key)}
                  <tr>
                    <td class="text-fg">{cat.label}</td>
                    <td class="tnum text-right text-fg-muted">{formatMoneyCompact(cat.baseline)}</td>
                    <td class="tnum text-right text-fg-muted">{formatMoneyCompact(cat.current)}</td>
                    <td class="tnum text-right font-medium {cat.change >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedMoneyCompact(cat.change)}</td>
                  </tr>
                {/each}
                <tr class="font-semibold [&>td]:border-t [&>td]:border-border">
                  <td class="text-fg">Total</td>
                  <td class="tnum text-right text-fg">{economy.networth.baseline !== null ? formatMoneyCompact(economy.networth.baseline) : "—"}</td>
                  <td class="tnum text-right text-fg">{economy.networth.current.value !== null ? formatMoneyCompact(economy.networth.current.value) : "—"}</td>
                  <td class="tnum text-right {economy.networth.change.value !== null && economy.networth.change.value < 0 ? 'text-negative' : economy.networth.change.value === null ? 'text-fg' : 'text-positive'}">
                    {economy.networth.coverage === "none" ? "Insufficient history" : formatSignedMoneyCompact(economy.networth.change.value)}
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
      {/if}
    </section>

    <!-- Cash flow charts -->
    <Panel title="Cumulative net cash flow" caption="Running cash flow across the selected range" flush>
      {#if !cumulativeOption}
        <StateMessage state="empty" compact title="No money events in this range" />
      {:else}
        <Chart option={cumulativeOption} height={300} />
      {/if}
    </Panel>

    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Cash received vs spent" caption="Per-day cash movement in both directions" flush>
        {#if !flowOption}
          <StateMessage state="empty" compact title="No flow to show" />
        {:else}
          <Chart option={flowOption} height={260} />
        {/if}
      </Panel>
      <Panel title="Received vs spent mix" caption="Top categories by side — legends sit below each chart, never over the graphic">
        {#if summary.incomeByCategory.length === 0 && summary.expensesByCategory.length === 0}
          <StateMessage state="empty" compact title="No categories to break down" />
        {:else}
          <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div class="min-w-0">
              <p class="mb-1 text-center text-[11px] font-semibold uppercase tracking-[0.13em] text-positive">Cash received</p>
              {#if receivedDonut}
                <Chart option={receivedDonut} height={170} />
              {:else}
                <div class="flex h-[170px] items-center justify-center text-xs text-fg-faint">No received cash in this range</div>
              {/if}
              <ul class="mx-auto mt-2 grid max-w-sm gap-1 text-xs">
                {#each receivedSlices as slice (slice.name)}
                  <li class="flex items-baseline gap-2">
                    <span class="h-2 w-2 shrink-0 rounded-full" style="background: {slice.color}"></span>
                    <span class="min-w-0 flex-1 truncate text-fg-muted" title={slice.name}>{slice.name}</span>
                    <span class="tnum text-fg-muted">{formatMoneyCompact(slice.value)}</span>
                    <span class="tnum w-9 text-right text-fg-faint">{Math.round(slice.share * 100)}%</span>
                  </li>
                {/each}
              </ul>
            </div>
            <div class="min-w-0">
              <p class="mb-1 text-center text-[11px] font-semibold uppercase tracking-[0.13em] text-negative">Cash spent</p>
              {#if spentDonut}
                <Chart option={spentDonut} height={170} />
              {:else}
                <div class="flex h-[170px] items-center justify-center text-xs text-fg-faint">No spent cash in this range</div>
              {/if}
              <ul class="mx-auto mt-2 grid max-w-sm gap-1 text-xs">
                {#each spentSlices as slice (slice.name)}
                  <li class="flex items-baseline gap-2">
                    <span class="h-2 w-2 shrink-0 rounded-full" style="background: {slice.color}"></span>
                    <span class="min-w-0 flex-1 truncate text-fg-muted" title={slice.name}>{slice.name}</span>
                    <span class="tnum text-fg-muted">{formatMoneyCompact(slice.value)}</span>
                    <span class="tnum w-9 text-right text-fg-faint">{Math.round(slice.share * 100)}%</span>
                  </li>
                {/each}
              </ul>
            </div>
          </div>
        {/if}
      </Panel>
    </section>

    <!-- Ledger -->
    <Panel title="The cash ledger" caption="Every real cash movement recorded from Torn logs — deduplicated, exact amounts">
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <select bind:value={category} class="input !h-8 w-40">
          <option value="">All categories</option>
          {#each MONEY_CATEGORIES as cat (cat)}
            <option value={cat}>{cat}</option>
          {/each}
        </select>
        <select bind:value={direction} class="input !h-8 w-32">
          <option value="">In &amp; out</option>
          <option value="income">Cash in</option>
          <option value="expense">Cash out</option>
        </select>
        <input
          placeholder="Search description…"
          bind:value={search}
          oninput={onSearchInput}
          class="input !h-8 w-full sm:w-56"
        />
      </div>

      {#if eventsError}
        <StateMessage state="error" compact title="Could not load ledger" hint={eventsError} action={{ label: "Retry", run: () => void loadEvents(false) }} />
      {:else if !events || (events.items.length === 0 && !eventsLoading)}
        <StateMessage state="empty" compact title="No ledger entries match" hint="Loosen the filters, or wait for the next sync." />
      {:else}
        <div class="overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Description</th>
                <th class="text-right">In</th>
                <th class="text-right">Out</th>
              </tr>
            </thead>
            <tbody>
              {#each events.items as event (event.id)}
                <tr>
                  <td class="tnum whitespace-nowrap text-xs text-fg-faint">{formatDateTime(event.occurredAt)}</td>
                  <td>
                    <span class="chip">{humanLabel(event.category)}</span>
                  </td>
                  <td class="max-w-[360px] truncate text-fg" title={event.description ?? ""}>{event.description ?? event.subcategory ?? "—"}</td>
                  <td class="tnum text-right font-medium {event.direction === 'income' ? 'text-positive' : 'text-fg-faint'}">
                    {event.direction === "income" ? formatMoneyFull(event.amount) : ""}
                  </td>
                  <td class="tnum text-right font-medium {event.direction === 'expense' ? 'text-negative' : 'text-fg-faint'}">
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
            <button class="btn btn-sm" onclick={() => void loadEvents(true)}>
              Load more
            </button>
          {/if}
        </div>
      {/if}
    </Panel>
  {/if}
</div>
