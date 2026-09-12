<script lang="ts">
  import { goto } from "$app/navigation";
  import type { DateRangePreset, EconomySummaryResponse, MoneyEventDto, Paginated } from "@tornscope/shared";
  import { MONEY_CATEGORIES, formatMoneyCompact, formatMoneyFull, formatDateTime, formatKpiValue, periodLabel, formatSignedMoney, formatSignedMoneyCompact, formatDate } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { incomeLabel, expenseLabel, humanLabel } from "@tornscope/shared";
  import { tick } from "svelte";
  import { createLoadGuard } from "$lib/loadGuard";
  import { dateRange, DATE_PRESETS, setPreset, setCustomRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import LensSwitcher from "$lib/components/LensSwitcher.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, ct, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, moneyValueAxis, moneyTooltipValue, dayLabel, tealArea, MOTION, surface } from "$lib/charts";

  let economy = $state<EconomySummaryResponse | null>(null);
  let events = $state<Paginated<MoneyEventDto> | null>(null);
  let loading = $state(true);
  let eventsLoading = $state(false);
  let error = $state<string | null>(null);
  let eventsError = $state<string | null>(null);
  let reloadToken = $state(0);

  let category = $state("");
  let direction = $state("");
  let search = $state("");

  const summaryGuard = createLoadGuard();
  const eventsGuard = createLoadGuard();

  async function loadSummary() {
    const seq = summaryGuard.begin();
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const res = await endpoints.economy(range);
      if (!summaryGuard.isCurrent(seq)) return; // a newer range superseded this response
      economy = res;
    } catch (err) {
      if (!summaryGuard.isCurrent(seq)) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    }
  }

  async function loadEvents(append = false) {
    const seq = eventsGuard.begin();
    eventsLoading = true;
    eventsError = null;
    try {
      const result = await endpoints.moneyEvents(
        { preset: dateRange.preset, from: dateRange.from, to: dateRange.to },
        { limit: 50, category: category || undefined, direction: direction || undefined, search: search || undefined }
      );
      if (!eventsGuard.isCurrent(seq)) return; // a newer range superseded this response
      events = append && events ? { items: [...events.items, ...result.items], nextCursor: result.nextCursor } : result;
    } catch (err) {
      if (!eventsGuard.isCurrent(seq)) return;
      eventsError = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      if (eventsGuard.isCurrent(seq)) {
        eventsLoading = false;
        loading = false;
      }
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

  /* ----------------------------- lens switching --------------------------- */
  const LENSES = [
    { id: "cash", label: "Cash movement" },
    { id: "conversions", label: "Conversions" },
    { id: "effect", label: "Economic effect" },
    { id: "networth", label: "Net worth" },
  ];
  let activeLens = $state("cash");

  /** At-a-glance lens chips: select the lens (mobile/tablet) and scroll to it (desktop shows all). */
  function jumpToLens(id: string) {
    activeLens = id;
    void tick().then(() => {
      document.getElementById(`lens-panel-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ------------- URL ↔ view state (shareable range/lens links) ------------ */
  // Restore from the URL once on arrival.
  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get("range");
    if (r && DATE_PRESETS.some((p) => p.value === r)) setPreset(r as DateRangePreset);
    else if (r === "custom") {
      const from = Number(params.get("from"));
      const to = Number(params.get("to"));
      if (Number.isFinite(from) && Number.isFinite(to) && to > 0) setCustomRange(from, to);
    }
    const lens = params.get("lens");
    if (lens && LENSES.some((l) => l.id === lens)) activeLens = lens;
  });
  // Reflect changes into the URL without SPA navigation.
  $effect(() => {
    const preset = dateRange.preset;
    const from = dateRange.from;
    const to = dateRange.to;
    const lens = activeLens;
    const url = new URL(window.location.href);
    url.searchParams.set("range", preset);
    if (preset === "custom" && from !== undefined && to !== undefined) {
      url.searchParams.set("from", String(from));
      url.searchParams.set("to", String(to));
    } else {
      url.searchParams.delete("from");
      url.searchParams.delete("to");
    }
    if (lens !== "cash") url.searchParams.set("lens", lens);
    else url.searchParams.delete("lens");
    window.history.replaceState({}, "", url);
  });

  // Permission-aware sections: unavailable data must never render as zeros.
  const cashAv = $derived(economy?.availability?.cashFlow);
  const cashBlocked = $derived(cashAv !== undefined && !availabilityHasData(cashAv));
  const cashStale = $derived(cashAv && cashAv.state === "stale_permission" ? availabilityMessage(cashAv) : null);
  const nwAv = $derived(economy?.availability?.networth);
  const nwBlocked = $derived(nwAv !== undefined && !availabilityHasData(nwAv));

  /* --------------------------- editorial summary -------------------------- */
  const cash = $derived(economy?.cashFlow);
  const ecoEffect = $derived(economy?.economicEffect);
  const wallet = $derived(economy?.wallet);

  const editorial = $derived.by<{ lead: string | null; support: string[] }>(() => {
    if (!economy || !cash) return { lead: null, support: [] };
    const sentences: string[] = [];
    let lead: string | null = null;
    if (cash.income.value === null || cash.expenses.value === null) {
      lead = "Cash flow isn't available for this range yet — nothing is estimated to fill the gap.";
    } else {
      lead = `Across ${period === "All" ? "all time" : period}, ${formatMoneyCompact(cash.income.value)} entered your wallet and ${formatMoneyCompact(cash.expenses.value)} left it.`;
      if (cash.expenses.value > 0) {
        if (cash.assetOutflow >= cash.trueExpense) sentences.push("Most of the outflow was asset conversion rather than true expense.");
        else sentences.push("Most of the outflow was true expense — value that left for good.");
      }
    }
    if (ecoEffect && ecoEffect.income.value !== null && ecoEffect.expenses.value !== null) {
      sentences.push(
        `Economic effect — earned ${formatMoneyCompact(ecoEffect.income.value)} against ${formatMoneyCompact(ecoEffect.expenses.value)} spent for good, a net of ${ecoEffect.net.value !== null ? formatSignedMoneyCompact(ecoEffect.net.value) : "—"}.`
      );
    }
    if (wallet && wallet.quality !== "unavailable" && wallet.closingWallet !== null && wallet.openingWallet !== null) {
      const change = wallet.closingWallet - wallet.openingWallet;
      if (Math.abs(change) >= 1 && wallet.explainedRatio !== null) {
        sentences.push(
          Math.abs(wallet.residual ?? 0) < 1
            ? "Recorded movements fully explain your wallet change."
            : `Recorded movements explain ${Math.round(wallet.explainedRatio * 100)}% of your wallet change; ${formatMoneyCompact(Math.abs(wallet.residual ?? 0))} remains unexplained by available money logs.`
        );
      }
    }
    return { lead, support: sentences };
  });

  /* ------------------------------ wallet rail ----------------------------- */
  const qualityChip = $derived.by(() => {
    const q = wallet?.quality ?? "unavailable";
    if (q === "exact") return { label: "Reconciled", cls: "chip-positive" };
    if (q === "small_residual") return { label: "Small residual", cls: "chip-warning" };
    if (q === "partial") return { label: "Partial history", cls: "chip-warning" };
    if (q === "unreconciled") return { label: "Unreconciled", cls: "chip-warning" };
    return { label: "No anchors", cls: "chip-quiet" };
  });
  const residualTone = $derived.by(() => {
    const r = wallet?.residual;
    if (r === null || r === undefined) return "text-fg-faint";
    if (Math.abs(r) < 1) return "text-fg-muted";
    const scale = Math.max(Math.abs(wallet?.recordedNet ?? 0), 1);
    return Math.abs(r) <= scale * 0.02 ? "text-fg-muted" : "text-warning";
  });

  /* --------------------------- consumption labels ------------------------- */
  const CONSUMPTION_LABELS: Record<string, string> = {
    drug: "Drugs consumed",
    booster: "Boosters",
    medical: "Medical items",
    happy_jump: "Happy Items",
    energy: "Energy drinks",
    candy: "Candy",
    temporary: "Temporary items",
    drug_pack: "Drug Packs (each converts into drugs, valued when used)",
    other: "Other consumables",
  };
  const topConsumedValue = $derived(economy?.consumption.byCategory[0]?.totalValue || 1);

  /** Category meaning chips: which cash-out rows are conversions vs expenses. */
  const ASSET_BUY_CATEGORIES = new Set(["bazaar", "items", "trading", "auction", "points", "stock", "travel", "plushie", "flower", "drugs"]);
  const expenseBreakdown = $derived(
    (economy?.cashFlow.expensesByCategory ?? []).map((row) => ({
      label: expenseLabel(String(row.category)),
      category: String(row.category),
      total: row.total,
      conversion: ASSET_BUY_CATEGORIES.has(String(row.category)),
    }))
  );
  const incomeBreakdown = $derived(
    (economy?.cashFlow.incomeByCategory ?? []).map((row) => ({
      label: incomeLabel(String(row.category)),
      category: String(row.category),
      total: row.total,
      conversion: ASSET_BUY_CATEGORIES.has(String(row.category)),
    }))
  );

  /* -------------------------- net worth contributors ---------------------- */
  const recordedContributors = $derived((economy?.explanation.contributors ?? []).filter((c) => c.certainty === "recorded"));
  const estimatedContributors = $derived((economy?.explanation.contributors ?? []).filter((c) => c.certainty === "estimated"));
  const residualContributors = $derived((economy?.explanation.contributors ?? []).filter((c) => c.certainty === "unexplained"));

  /** Distinct pie ramps: inflow (greens/teals) vs outflow (reds/ambers) —
   *  theme- and palette-aware via the shared chart theme. */
  const INFLOW_PALETTE = $derived(ct().inflowRamp);
  const OUTFLOW_PALETTE = $derived(ct().outflowRamp);
  const OTHERS_COLOR = $derived(ct().theme === "light" ? "#83826f" : "#6e6e78");
  const DONUT_TOP_N = 5;

  /**
   * Slice categories into top-N + "Everything else", with the EXACT colors
   * the donut uses so the external legend always matches the graphic.
   */
  function donutSlices(rows: Array<{ category: string; total: number }>, palette: string[], labeler: (category: string) => string, othersColor?: string) {
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
        color: othersColor ?? "#6e6e78",
        share: rest.reduce((s, r) => s + r.total, 0) / total,
      });
    }
    return slices;
  }

  /** Compact donut: NO in-chart legend — the legend is rendered as HTML below. */
  function donutOption(slices: Array<{ name: string; value: number; color: string }>, name: string) {
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "item", formatter: (p: { name?: string; value?: number; percent?: number }) => `${p.name}: ${formatMoneyCompact(p.value ?? 0)} (${p.percent}%)` },
      series: [
        {
          name,
          type: "pie",
          radius: ["56%", "80%"],
          center: ["50%", "50%"],
          label: { show: false },
          labelLine: { show: false },
          itemStyle: { borderRadius: 4, borderColor: surface(), borderWidth: 2 },
          data: slices.map((s) => ({ name: s.name, value: s.value, itemStyle: { color: s.color } })),
        },
      ],
    };
  }

  const receivedSlices = $derived(donutSlices(economy?.cashFlow.incomeByCategory ?? [], INFLOW_PALETTE, incomeLabel, OTHERS_COLOR));
  const spentSlices = $derived(donutSlices(economy?.cashFlow.expensesByCategory ?? [], OUTFLOW_PALETTE, expenseLabel, OTHERS_COLOR));
  const receivedDonut = $derived(receivedSlices.length > 0 ? donutOption(receivedSlices, "Cash received") : null);
  const spentDonut = $derived(spentSlices.length > 0 ? donutOption(spentSlices, "Cash spent") : null);

  const cumulativeOption = $derived.by(() => {
    const series = economy?.series.cumulativeNet ?? [];
    if (series.length === 0) return null;
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "axis", valueFormatter: moneyTooltipValue() },
      grid: { ...GRID, top: 20 },
      xAxis: timeAxis(series.map((p) => dayLabel(p.t))),
      yAxis: moneyValueAxis(),
      series: [
        {
          name: "Cumulative net cash movement",
          type: "line",
          data: series.map((p) => p.net),
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: C.accent, width: 2 },
          areaStyle: tealArea(),
        },
      ],
    };
  });

  const flowOption = $derived.by(() => {
    const series = economy?.series.flow ?? [];
    if (series.length === 0) return null;
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "axis", valueFormatter: moneyTooltipValue() },
      legend: { ...LEGEND, data: ["Cash received", "Cash spent"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(series.map((p) => dayLabel(p.t)), { boundaryGap: true }),
      yAxis: moneyValueAxis(),
      series: [
        { name: "Cash received", type: "bar", data: series.map((p) => p.income), barMaxWidth: 12, itemStyle: { color: C.positive, borderRadius: [3, 3, 0, 0] } },
        { name: "Cash spent", type: "bar", data: series.map((p) => -p.expenses), barMaxWidth: 12, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });

  const conversionBarTop = $derived(economy?.conversions.byPair[0]?.amount || 1);
</script>

<svelte:head><title>Economy · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Finance"
    title="Economy"
    description="Four related lenses — cash movement, asset conversions, economic effect and net worth. Related, never additive: they answer different questions about the same money."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !economy}
    <StateMessage state="loading" />
  {:else if error && !economy}
    <StateMessage state="error" title="Could not load economy analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if economy}
    <!-- ═══ Editorial summary — what happened, in words, before numbers ═══ -->
    <section aria-labelledby="economy-editorial" class="rounded-card border border-border bg-surface px-5 py-5 shadow-panel sm:px-7">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="economy-editorial" class="section-label !tracking-[0.12em]">{period} at a glance</h2>
        <div class="flex flex-wrap items-center gap-2">
            <button class="chip chip-quiet cursor-pointer !border-border !text-[10px]" title="Money that moved through the wallet" onclick={() => jumpToLens("cash")}>cash movement</button>
            <button class="chip chip-quiet cursor-pointer !border-border !text-[10px]" title="Value changing form — not gain or loss" onclick={() => jumpToLens("conversions")}>conversion</button>
            <button class="chip chip-quiet cursor-pointer !border-border !text-[10px]" title="Value gained or lost" onclick={() => jumpToLens("effect")}>economic effect</button>
            <button class="chip chip-quiet cursor-pointer !border-border !text-[10px]" title="Official Torn snapshot delta — not profit" onclick={() => jumpToLens("networth")}>net worth</button>
        </div>
      </div>
      {#if editorial.lead}
        <p class="mt-3 max-w-4xl font-display text-lg leading-relaxed text-fg sm:text-xl">{editorial.lead}</p>
        {#each editorial.support as sentence (sentence)}
          <p class="mt-2 max-w-4xl text-sm leading-relaxed text-fg-muted">{sentence}</p>
        {/each}
      {:else}
        <p class="mt-3 max-w-4xl text-sm leading-relaxed text-fg-muted">Waiting for enough history to say anything honest about this range.</p>
      {/if}
    </section>

    <!-- ═══ Lens switcher (mobile / tablet — desktop shows every lens) ═══ -->
    <div class="lg:hidden">
      <LensSwitcher tabs={LENSES} active={activeLens} onselect={(id) => (activeLens = id)} />
    </div>

    <div class="grid gap-8 lg:grid-cols-3 lg:gap-10">
      <!-- ══════════════════ main analytics (2/3 on desktop) ═══════════════ -->
      <div class="min-w-0 space-y-10 lg:col-span-2 lg:space-y-12">
        {#if cashBlocked && cashAv}
          <StateMessage
            state={availabilityMessage(cashAv).state}
            title={availabilityMessage(cashAv).title}
            hint={availabilityMessage(cashAv).hint}
            action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
          />
        {:else}
          {#if cashStale}
            <p class="rounded-tile border border-warning/30 bg-warning/5 px-5 py-3 text-xs leading-relaxed text-warning">
              <span class="font-medium">{cashStale.title}.</span>
              {cashStale.hint}
            </p>
          {/if}

          <!-- ─────────────── Lens 1 · Cash movement ─────────────── -->
          <div id="lens-panel-cash" role="tabpanel" aria-labelledby="lens-tab-cash" class="space-y-5 {activeLens === 'cash' ? '' : 'max-lg:hidden'}">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">1</span> Cash movement — money that moved through your wallet</h2>
              <span class="chip chip-quiet !border-border !text-[10px]" title="Cash in and out is not the same as income and expense">cash ≠ income</span>
            </div>
            <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
              <Stat label="{period} Cash received" value={formatKpiValue(economy.cashFlow.income)} provenance="exact" tone="positive" confidence={economy.confidence?.cashFlow} sub={`earned ${formatMoneyCompact(economy.cashFlow.trueIncome)} · asset sales ${formatMoneyCompact(economy.cashFlow.assetInflow)}`} />
              <Stat label="{period} Cash spent" value={formatKpiValue(economy.cashFlow.expenses)} provenance="exact" tone="negative" confidence={economy.confidence?.cashFlow} sub={`true expenses ${formatMoneyCompact(economy.cashFlow.trueExpense)} · asset purchases ${formatMoneyCompact(economy.cashFlow.assetOutflow)}`} />
              <Stat
                label="{period} Net cash movement"
                value={formatKpiValue(economy.cashFlow.netCashFlow)}
                provenance="exact"
                confidence={economy.confidence?.cashFlow}
                tone={economy.cashFlow.netCashFlow.value === null ? "neutral" : economy.cashFlow.netCashFlow.value >= 0 ? "positive" : "negative"}
              />
              <Stat label="Unclassified rows" value={String(economy.cashFlow.unclassifiedCount)} provenance="exact" confidence={economy.confidence?.cashFlow} sub={economy.cashFlow.unclassifiedCount > 0 ? "recorded, not yet interpretable" : "every row classified"} />
            </div>

            <!-- Donut legends need ~210px min-content per column; two chart panels only
                 genuinely fit side by side on very wide screens. -->
            <section class="grid gap-6 min-[1500px]:grid-cols-2">
              <Panel title="Cash received vs spent" caption="Per-bucket cash movement in both directions — cash flow, not income" flush>
                {#if !flowOption}
                  <StateMessage state="empty" compact title="No flow to show" />
                {:else}
                  <Chart option={flowOption} height={260} />
                {/if}
              </Panel>
              <Panel title="Received vs spent mix" caption="Top categories by side — legends sit below each chart, never over the graphic">
                {#if (economy.cashFlow.incomeByCategory ?? []).length === 0 && (economy.cashFlow.expensesByCategory ?? []).length === 0}
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

            <Panel title="Cash received by category" caption="Asset sales are conversions (value you already owned changing form) — they are not earnings">
              {#if incomeBreakdown.length === 0}
                <StateMessage state="empty" compact title="No cash received in this range" />
              {:else}
                <div class="overflow-x-auto">
                  <table class="tsv-table">
                    <thead>
                      <tr>
                        <th>Category</th>
                        <th>Meaning</th>
                        <th class="text-right">Cash in</th>
                        <th class="text-right">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each incomeBreakdown as row (row.category + row.label)}
                        <tr>
                          <td class="text-fg">{row.label}</td>
                          <td>
                            {#if row.conversion}
                              <span class="chip chip-quiet !border-border !px-1.5 !text-[9px] !uppercase" title="Asset → cash conversion — not earnings">conversion</span>
                            {:else}
                              <span class="chip chip-positive !px-1.5 !text-[9px] !uppercase">earned</span>
                            {/if}
                          </td>
                          <td class="tnum text-right {row.conversion ? 'text-fg-muted' : 'text-positive'}">{formatMoneyCompact(row.total)}</td>
                          <td class="tnum text-right text-fg-faint">{Math.round((row.total / (economy.cashFlow.income.value || 1)) * 100)}%</td>
                        </tr>
                      {/each}
                      <tr class="font-semibold [&>td]:border-t [&>td]:border-border">
                        <td colspan="2" class="text-fg">Total cash received</td>
                        <td class="tnum text-right text-positive">{economy.cashFlow.income.value !== null ? formatMoneyCompact(economy.cashFlow.income.value) : "—"}</td>
                        <td class="tnum text-right text-fg-faint">100%</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              {/if}
            </Panel>

            <Panel title="Cash spent by category" caption="Buying inventory is an asset purchase — using it later is consumption (economic effect lens), never the same accounting event">
              {#if expenseBreakdown.length === 0}
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
                      {#each expenseBreakdown as row (row.category + row.label)}
                        <tr>
                          <td class="text-fg">{row.label}</td>
                          <td>
                            {#if row.conversion}
                              <span class="chip chip-quiet !border-border !px-1.5 !text-[9px] !uppercase" title="Value still owned in another form — not an economic loss">asset conversion</span>
                            {:else}
                              <span class="chip chip-negative !px-1.5 !text-[9px] !uppercase">true expense</span>
                            {/if}
                          </td>
                          <td class="tnum text-right {row.conversion ? 'text-fg-muted' : 'text-negative'}">{formatMoneyCompact(row.total)}</td>
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

            <Panel title="Cumulative net cash movement" caption="Running cash flow across the selected range — a wallet-basis figure, not wealth change" flush>
              {#if !cumulativeOption}
                <StateMessage state="empty" compact title="No money events in this range" />
              {:else}
                <Chart option={cumulativeOption} height={280} />
              {/if}
            </Panel>
          </div>

          <!-- ─────────────── Lens 2 · Asset conversions ─────────────── -->
          <div id="lens-panel-conversions" role="tabpanel" aria-labelledby="lens-tab-conversions" class="space-y-5 {activeLens === 'conversions' ? '' : 'max-lg:hidden'}">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">2</span> Asset conversions — value changing form, not gain or loss</h2>
              <span class="chip chip-quiet !border-border !text-[10px]" title="Conversions are neither income nor spending">conversion ≠ income</span>
            </div>
            <details class="group rounded-tile border border-border bg-surface px-5 py-3">
              <summary class="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
                Why conversions are kept apart from income
                <span class="transition-transform group-open:rotate-180">▾</span>
              </summary>
              <p class="mt-2.5 border-t border-border pt-2.5 text-xs leading-relaxed text-fg-muted">
                A bank deposit, a stock purchase or a bazaar sale changes the FORM of value you already own — cash becomes an asset, or an asset becomes
                cash. Nothing is gained or lost at that moment, so conversions never enter income, expenses or economic effect. They still move your
                wallet, which is why the wallet reconciliation counts them.
              </p>
            </details>
            <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
              <Stat label="Cash → assets" value={formatKpiValue(economy.conversions.cashIntoAssets)} provenance="exact" confidence={economy.confidence?.cashFlow} title="Cash that left the wallet into things you still own" />
              <Stat label="Assets → cash" value={formatKpiValue(economy.conversions.assetsIntoCash)} provenance="exact" tone="accent" confidence={economy.confidence?.cashFlow} title="Value you owned that returned to the wallet as cash" />
              <Stat
                label="Net cash effect"
                value={formatKpiValue(economy.conversions.netCashEffect, formatSignedMoneyCompact)}
                provenance="derived"
                confidence={economy.confidence?.cashFlow}
                title="Assets → cash minus cash → assets: how far conversions drained or refilled the wallet"
              />
              <Stat label="Bank movements" value={formatMoneyCompact(economy.conversions.bankTransfers)} provenance="exact" confidence={economy.confidence?.cashFlow} sub="wallet ↔ bank, both directions" />
            </div>

            <Panel title="Conversion pairs" caption="Every conversion route in this range, largest first">
              {#if economy.conversions.byPair.length === 0}
                <StateMessage state="empty" compact title="No conversions in this range" hint="Bank deposits, stock or item trades will appear here." />
              {:else}
                <ul class="space-y-4">
                  {#each economy.conversions.byPair as row (row.pair)}
                    <li>
                      <div class="flex items-baseline justify-between gap-3 text-[13px]">
                        <span class="text-fg">
                          {row.label}
                          <span class="ml-1.5 text-[11px] text-fg-faint">{row.count} movement{row.count === 1 ? "" : "s"}</span>
                        </span>
                        <span class="tnum font-medium text-fg-muted">{formatMoneyCompact(row.amount)}</span>
                      </div>
                      <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <div class="h-full rounded-full bg-accent/60" style="width: {Math.round((row.amount / conversionBarTop) * 100)}%"></div>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </Panel>

            {#if economy.sales.cashReceived > 0}
              <div class="grid grid-cols-1 gap-px overflow-hidden rounded-tile border border-border bg-border md:grid-cols-3">
                <div class="bg-surface p-4 sm:p-5">
                  <p class="text-[11px] font-medium text-fg-faint">Sale proceeds <span class="uppercase tracking-wide">(cash received)</span></p>
                  <p class="tnum mt-1 text-xl font-semibold text-fg">{formatMoneyCompact(economy.sales.cashReceived)}</p>
                </div>
                <div class="bg-surface p-4 sm:p-5">
                  <p class="text-[11px] font-medium text-fg-faint">Estimated item value sold</p>
                  <p class="tnum mt-1 text-xl font-semibold text-fg-muted">{economy.sales.inventoryValueRemoved !== null ? formatMoneyCompact(economy.sales.inventoryValueRemoved) : "—"}</p>
                </div>
                <div class="bg-surface p-4 sm:p-5">
                  <p class="text-[11px] font-medium text-fg-faint" title="Sale proceeds minus estimated catalog value of the sold items. Not called profit: acquisition cost is not reliably known.">Estimated value difference</p>
                  <p class="tnum mt-1 text-xl font-semibold {economy.sales.economicResult === null ? 'text-fg-faint' : economy.sales.economicResult >= 0 ? 'text-positive' : 'text-negative'}">
                    {economy.sales.economicResult !== null ? formatSignedMoneyCompact(economy.sales.economicResult) : "—"}
                  </p>
                  <p class="mt-1 text-[10.5px] leading-relaxed text-fg-faint">
                    {economy.sales.provenance === "estimated" ? "estimated from current catalog prices" : "item valuation unavailable for this range"}
                  </p>
                </div>
              </div>
            {/if}
          </div>

          <!-- ─────────────── Lens 3 · Economic effect ─────────────── -->
          <div id="lens-panel-effect" role="tabpanel" aria-labelledby="lens-tab-effect" class="space-y-5 {activeLens === 'effect' ? '' : 'max-lg:hidden'}">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">3</span> Economic effect — value genuinely gained or lost</h2>
              <span class="chip chip-quiet !border-border !text-[10px]" title="The closest figure to profit and loss — but never labeled profit, because acquisition costs are unknown">economic effect, not profit</span>
            </div>
            <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
              <Stat label="Income (earned)" value={formatKpiValue(economy.economicEffect.income)} provenance={economy.economicEffect.income.provenance} tone="positive" confidence={economy.economicEffect.confidence} title="Earned money plus derived bank interest — conversions excluded" />
              <Stat label="Expenses (true)" value={formatKpiValue(economy.economicEffect.expenses)} provenance="exact" tone="negative" confidence={economy.economicEffect.confidence} title="Value consumed or paid away — asset purchases excluded" />
              <Stat
                label="Net economic effect"
                value={formatKpiValue(economy.economicEffect.net, formatSignedMoneyCompact)}
                provenance={economy.economicEffect.net.provenance}
                confidence={economy.economicEffect.confidence}
                tone={economy.economicEffect.net.value === null ? "neutral" : economy.economicEffect.net.value >= 0 ? "positive" : "negative"}
              />
              <Stat
                label="Bank interest (derived)"
                value={economy.economicEffect.interestIncome !== 0 || economy.economicEffect.interestComplete ? formatMoneyCompact(economy.economicEffect.interestIncome) : "—"}
                provenance="derived"
                confidence={economy.economicEffect.confidence}
                sub={economy.economicEffect.interestComplete ? "split from principal returns" : "some withdrawals could not be split — figure may understate"}
              />
            </div>
            {#if !economy.economicEffect.interestComplete}
              <p class="rounded-tile border border-warning/30 bg-warning/5 px-5 py-3 text-xs leading-relaxed text-warning">
                Some bank withdrawals in this range have their principal outside the recorded history, so their interest cannot be split out. Bank
                interest is understated rather than guessed.
              </p>
            {/if}

            <section class="grid gap-6 lg:grid-cols-2">
              <Panel title="Income sources" caption="Earned value — payouts, wages, yields. Asset sales never appear here.">
                {#if economy.economicEffect.incomeCategories.length === 0}
                  <StateMessage state="empty" compact title="No earned income in this range" />
                {:else}
                  <ul class="space-y-2.5 text-[13px]">
                    {#each economy.economicEffect.incomeCategories as row (row.key + row.label)}
                      <li class="flex items-baseline justify-between gap-3">
                        <span class="text-fg">{row.label}</span>
                        <span class="tnum font-medium text-positive">{formatMoneyCompact(row.total)}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </Panel>
              <Panel title="True expenses" caption="Value that left for good — rehab, fees, upkeep, gym, rent.">
                {#if economy.economicEffect.expenseCategories.length === 0}
                  <StateMessage state="empty" compact title="No true expenses in this range" />
                {:else}
                  <ul class="space-y-2.5 text-[13px]">
                    {#each economy.economicEffect.expenseCategories as row (row.key + row.label)}
                      <li class="flex items-baseline justify-between gap-3">
                        <span class="text-fg">{row.label}</span>
                        <span class="tnum font-medium text-negative">{formatMoneyCompact(row.total)}</span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </Panel>
            </section>

            <!-- Estimated economic context — provenance-labeled, never merged -->
            <Panel title="Estimated economic context" caption="Catalog-based estimates — shown for context, never merged into the figures above">
              <div class="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-border bg-border md:grid-cols-4">
                <div class="bg-surface p-4">
                  <div class="flex items-center justify-between gap-2"><p class="text-[11px] font-medium text-fg-faint">Consumed value</p><ProvenanceBadge level="estimated" /></div>
                  <p class="tnum mt-1 text-lg font-semibold text-negative">{formatKpiValue(economy.consumption.totalValue)}</p>
                </div>
                <div class="bg-surface p-4">
                  <div class="flex items-center justify-between gap-2"><p class="text-[11px] font-medium text-fg-faint">Drugs consumed</p><ProvenanceBadge level="estimated" /></div>
                  <p class="tnum mt-1 text-lg font-semibold text-negative">{economy.consumption.drugValue !== null ? formatMoneyCompact(economy.consumption.drugValue) : "—"}</p>
                </div>
                <div class="bg-surface p-4">
                  <div class="flex items-center justify-between gap-2"><p class="text-[11px] font-medium text-fg-faint">Travel profit</p><ProvenanceBadge level="estimated" /></div>
                  <p class="tnum mt-1 text-lg font-semibold {economy.travel.estimatedProfit.value === null ? 'text-fg-faint' : economy.travel.estimatedProfit.value >= 0 ? 'text-positive' : 'text-negative'}">{formatKpiValue(economy.travel.estimatedProfit)}</p>
                </div>
                <div class="bg-surface p-4">
                  <div class="flex items-center justify-between gap-2"><p class="text-[11px] font-medium text-fg-faint">Non-cash wealth gained</p><ProvenanceBadge level={economy.nonCashGains.provenance === "estimated" ? "estimated" : "exact"} /></div>
                  <p class="tnum mt-1 text-lg font-semibold text-fg-muted">{economy.nonCashGains.value !== null ? formatMoneyCompact(economy.nonCashGains.value) : "—"}</p>
                </div>
              </div>
              {#if economy.consumption.byCategory.length > 0}
                <ul class="mt-5 space-y-4">
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
                    {economy.consumption.valueUnknownCount} use{economy.consumption.valueUnknownCount === 1 ? "" : "s"} without a known price {economy.consumption.valueUnknownCount === 1 ? "is" : "are"} counted as use{economy.consumption.valueUnknownCount === 1 ? "" : "s"} but add{economy.consumption.valueUnknownCount === 1 ? "s" : ""} nothing to Consumed Value — never an invented price.
                  </p>
                {/if}
              {/if}
            </Panel>
          </div>

          <!-- ─────────────── Lens 4 · Net worth ─────────────── -->
          <div id="lens-panel-networth" role="tabpanel" aria-labelledby="lens-tab-networth" class="space-y-5 {activeLens === 'networth' ? '' : 'max-lg:hidden'}">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">4</span> Net worth — official snapshot movement, not profit</h2>
              {#if economy.networth.trackingSince !== null}
                <span class="text-[11px] text-fg-faint">Tracking since {formatDate(economy.networth.trackingSince)}</span>
              {/if}
            </div>
            {#if nwBlocked && nwAv}
              <StateMessage
                state={availabilityMessage(nwAv).state}
                title={availabilityMessage(nwAv).title}
                hint={nwAv.state === "unavailable_permission" ? "Your current API key does not include User Networth — grant it in Torn to track wealth history." : availabilityMessage(nwAv).hint}
                action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
              />
            {:else}
              <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
                <Stat label="Opening net worth" value={economy.networth.baseline !== null ? formatMoneyCompact(economy.networth.baseline) : "—"} provenance="exact" confidence={economy.confidence?.networth} sub={economy.networth.baselineAt !== null ? `snapshot ${formatDate(economy.networth.baselineAt)}` : null} />
                <Stat label="Closing net worth" value={formatKpiValue(economy.networth.current)} provenance="exact" tone="accent" confidence={economy.confidence?.networth} sub={economy.networth.currentAt !== null ? `snapshot ${formatDate(economy.networth.currentAt)}` : null} />
                <Stat
                  label="Net worth change{economy.networth.coverage === 'partial' ? ' (partial)' : ''}"
                  value={economy.networth.coverage === "none" ? "Insufficient history" : formatSignedMoneyCompact(economy.networth.change.value)}
                  provenance="exact"
                  confidence={economy.confidence?.networth}
                  tone={economy.networth.change.value === null || economy.networth.coverage === "none" ? "neutral" : economy.networth.change.value >= 0 ? "positive" : "negative"}
                  sub={economy.networth.changePct !== null ? `${economy.networth.changePct >= 0 ? "+" : ""}${economy.networth.changePct.toFixed(2)}%` : null}
                />
                <Stat
                  label="vs economic effect"
                  value={economy.economicEffect.net.value !== null ? formatSignedMoneyCompact(economy.economicEffect.net.value) : "—"}
                  provenance={economy.economicEffect.net.provenance}
                  confidence={economy.economicEffect.confidence}
                  title="Side by side on purpose: the two figures measure different things and are never summed"
                />
              </div>
              <details class="group rounded-tile border border-border bg-surface px-5 py-3">
                <summary class="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
                  Why net worth change is not profit
                  <span class="transition-transform group-open:rotate-180">▾</span>
                </summary>
                <p class="mt-2.5 border-t border-border pt-2.5 text-xs leading-relaxed text-fg-muted">
                  Net worth change is the snapshot delta from official Torn net worth — it includes item/stock/property price moves as well as
                  spending and income, so it is a wealth movement, never "profit". Estimated economic effects are shown separately and never
                  merged into it.
                </p>
              </details>

              <Panel title="Likely contributors — recorded movements, not proven causes" caption="Official Torn category deltas first; estimated effects and the unexplained residual are labeled as such">
                {#if recordedContributors.length === 0 && residualContributors.length === 0}
                  <StateMessage state="empty" compact title="No net worth movement recorded in this range" />
                {:else}
                  <ul class="space-y-2.5 text-[13px]">
                    {#each recordedContributors as c (c.key)}
                      <li class="flex items-baseline justify-between gap-3">
                        <span class="text-fg">
                          {c.label}
                          <span class="ml-1.5 chip chip-quiet !border-border !px-1.5 !text-[9px] !uppercase" title="Official Torn net worth snapshot delta">recorded</span>
                        </span>
                        <span class="tnum font-medium {(c.value ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">{c.value !== null ? formatSignedMoneyCompact(c.value) : "—"}</span>
                      </li>
                    {/each}
                    {#each estimatedContributors as c (c.key)}
                      <li class="flex items-baseline justify-between gap-3">
                        <span class="text-fg-muted">
                          {c.label}
                          <span class="ml-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-warning" title="Estimated value — catalog-based, not an official figure">estimated</span>
                        </span>
                        <span class="tnum font-medium text-fg-muted">{c.value !== null ? formatSignedMoneyCompact(c.value) : "—"}</span>
                      </li>
                    {/each}
                    {#each residualContributors as c (c.key)}
                      <li class="flex items-baseline justify-between gap-3 border-t border-border pt-2.5">
                        <span class="text-fg-muted" title={c.source}>{c.label}</span>
                        <span class="tnum font-medium text-fg">{c.value !== null ? formatSignedMoneyCompact(c.value) : "—"}</span>
                      </li>
                    {/each}
                  </ul>
                  {#if economy.networth.byCategory.length > 0}
                    <div class="mt-5 overflow-x-auto">
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
                        </tbody>
                      </table>
                    </div>
                  {/if}
                  {#if economy.networth.coverage === "partial"}
                    <p class="mt-4 text-[11px] text-fg-faint">Tracked period: TornScope started snapshotting after this period began, so the change covers the tracked span only.</p>
                  {/if}
                {/if}
              </Panel>
            {/if}
          </div>
        {/if}
      </div>

      <!-- ══════════════════ rail: reconciliation + major movements ═════════ -->
      <aside class="min-w-0 space-y-6 lg:col-span-1" aria-label="Reconciliation and notable movements">
        <!-- ─────────────── Wallet reconciliation ─────────────── -->
        <Panel title="Wallet reconciliation" caption="Where actual wallet cash came from and went — wallet cash, not wealth">
          {#if !wallet}
            <StateMessage state="loading" skeleton="strip" />
          {:else if wallet.quality === "unavailable" || wallet.openingWallet === null || wallet.closingWallet === null}
            <p class="text-xs leading-relaxed text-fg-muted">
              Wallet reconciliation needs net worth snapshots at both ends of this range — pick a shorter range that starts after tracking began, and the full bridge appears here.
            </p>
            <dl class="mt-4 space-y-1.5 text-[13px]">
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Opening wallet</dt><dd class="tnum text-fg-faint">—</dd></div>
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Recorded inflows</dt><dd class="tnum text-positive">{wallet.openingWallet !== null || wallet.closingWallet !== null ? `+${formatMoneyCompact(wallet.recordedInflows)}` : "—"}</dd></div>
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Recorded outflows</dt><dd class="tnum text-negative">{wallet.openingWallet !== null || wallet.closingWallet !== null ? `-${formatMoneyCompact(wallet.recordedOutflows)}` : "—"}</dd></div>
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Expected closing</dt><dd class="tnum text-fg-faint">—</dd></div>
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Actual closing</dt><dd class="tnum text-fg-faint">—</dd></div>
              <div class="flex items-baseline justify-between gap-3 border-t border-border pt-1.5"><dt class="font-medium text-fg">Residual</dt><dd class="tnum font-semibold text-fg-faint">—</dd></div>
            </dl>
          {:else}
            <dl class="space-y-1.5 text-[13px]">
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-fg-muted">Opening wallet{#if wallet.openingSnapshotAt !== null}<span class="ml-1.5 text-[10px] text-fg-faint">{formatDate(wallet.openingSnapshotAt)}</span>{/if}</dt>
                <dd class="tnum text-fg">{formatMoneyCompact(wallet.openingWallet)}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Recorded inflows</dt><dd class="tnum text-positive">+{formatMoneyCompact(wallet.recordedInflows)}</dd></div>
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Recorded outflows</dt><dd class="tnum text-negative">-{formatMoneyCompact(wallet.recordedOutflows)}</dd></div>
              <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Expected closing</dt><dd class="tnum text-fg">{wallet.expectedClosingWallet !== null ? formatMoneyCompact(wallet.expectedClosingWallet) : "—"}</dd></div>
              <div class="flex items-baseline justify-between gap-3">
                <dt class="text-fg-muted">Actual closing{#if wallet.closingSnapshotAt !== null}<span class="ml-1.5 text-[10px] text-fg-faint">{formatDate(wallet.closingSnapshotAt)}</span>{/if}</dt>
                <dd class="tnum font-medium text-fg">{formatMoneyCompact(wallet.closingWallet)}</dd>
              </div>
              <div class="flex items-baseline justify-between gap-3 border-t border-border pt-1.5">
                <dt class="font-medium text-fg">
                  Residual
                  <span class="ml-1.5 {qualityChip.cls} chip !px-1.5 !text-[9px] !uppercase" title="Residual = actual closing − expected closing. Small residuals are rounding; larger ones mean movements the available money logs do not explain.">{qualityChip.label}</span>
                </dt>
                <dd class="tnum font-semibold {residualTone}">{wallet.residual !== null ? formatSignedMoney(wallet.residual) : "—"}</dd>
              </div>
            </dl>
            <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
              {#if wallet.residual !== null && Math.abs(wallet.residual) < 1}
                Every recorded movement accounted for — the residual is below a dollar.
              {:else if wallet.explainedRatio !== null && Math.abs(wallet.closingWallet - wallet.openingWallet) >= 1}
                {Math.round(wallet.explainedRatio * 100)}% of the wallet movement is explained by available history.
                {#if wallet.residual !== null && Math.abs(wallet.residual) >= 1}
                  {formatMoneyCompact(Math.abs(wallet.residual))} remains unexplained by available money logs — possibly a coverage gap, an unsupported Torn log type, or activity outside recorded history.
                {/if}
              {:else}
                Recorded movements are shown as recorded; no percentage is claimed.
              {/if}
            </p>
          {/if}
          {#if wallet && wallet.factionBalanceCredits > 0}
            <p class="mt-3 rounded-tile bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-fg-muted">
              {formatMoneyCompact(wallet.factionBalanceCredits)} in OC payouts went to your faction balance (withdrawable there), not your wallet — excluded from these flows.
            </p>
          {/if}
        </Panel>

        <!-- ─────────────── Major movements ─────────────── -->
        <Panel title="Major movements" caption="Largest recorded movements of the range, across all roles">
          {#if (economy.majorMovements ?? []).length === 0}
            <StateMessage state="empty" compact title="No significant movements in this range" />
          {:else}
            <ul class="divide-y divide-border text-[13px]">
              {#each economy.majorMovements as m (m.id)}
                <li class="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div class="min-w-0">
                    <p class="truncate text-fg" title={m.description ?? m.label}>{m.label}</p>
                    <p class="text-[10.5px] text-fg-faint">{formatDateTime(m.occurredAt)} · {m.role.replace("_", " ")}</p>
                  </div>
                  <span class="tnum shrink-0 font-medium {(m.role === 'expense' || m.role === 'conversion_out') ? 'text-fg-muted' : 'text-fg'}" title={m.description ?? ""}>
                    {m.role === "expense" ? `-${formatMoneyCompact(m.amount)}` : m.role === "conversion_out" ? `-${formatMoneyCompact(m.amount)}` : `+${formatMoneyCompact(m.amount)}`}
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </Panel>

        <!-- ─────────────── Methodology ─────────────── -->
        <details class="group rounded-tile border border-border bg-surface px-5 py-3">
          <summary class="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
            How these lenses relate
            <span class="transition-transform group-open:rotate-180">▾</span>
          </summary>
          <p class="mt-2.5 border-t border-border pt-2.5 text-xs leading-relaxed text-fg-muted">
            Cash movement counts money through the wallet. Conversions move value between forms. Economic effect counts value gained or lost.
            Net worth is the official snapshot delta. The lenses are related, not additive — cash net + economic net + conversion net does not
            equal net worth change, because net worth also includes market repricing and unobserved activity.
          </p>
        </details>
      </aside>
    </div>

    <!-- Ledger -->
    <Panel title="The cash ledger" caption="Every real cash movement recorded from Torn logs — deduplicated, exact amounts">
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <select bind:value={category} class="input !h-8 w-40">
          <option value="">All categories</option>
          {#each MONEY_CATEGORIES as cat (cat)}
            <option value={cat}>{humanLabel(cat)}</option>
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
