<script lang="ts">
  import { goto } from "$app/navigation";
  import type { StocksResponse, StockRowDto, FeatureAvailability as FeatureAvailabilityDto } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatMoneyCompact, formatNumberCompact } from "@tornscope/shared";
  import { formatRelative } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import * as td from "$lib/time-display.svelte.js";

  /**
   * Stocks — "a portfolio & benefit intelligence ledger".
   *
   * Shares are exact; position values, cost-to-benefit and yield/payback are
   * estimates at the CURRENT market price (freshness labeled). Rewards that
   * have no defensible valuation render as their description, never as $0.
   * Sources, formulas and honesty rules: docs/STOCKS.md.
   */

  let data = $state<StocksResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  // URL state: ?view=owned|all&sort=…
  let view = $state<"owned" | "all">("owned");
  let sort = $state<"position" | "closest" | "cost" | "annual" | "payback" | "name">("position");
  let expandedId = $state<number | null>(null);
  let loadSeq = 0;

  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("view");
    if (v === "all") view = "all";
    const s = params.get("sort");
    if (s === "closest" || s === "cost" || s === "annual" || s === "payback" || s === "name") sort = s;
  });

  function syncUrl() {
    const url = new URL(window.location.href);
    if (view !== "owned") url.searchParams.set("view", view);
    else url.searchParams.delete("view");
    if (sort !== "position") url.searchParams.set("sort", sort);
    else url.searchParams.delete("sort");
    window.history.replaceState({}, "", url);
  }

  async function load() {
    const seq = ++loadSeq;
    loading = true;
    error = null;
    try {
      const res = await endpoints.stocks();
      if (seq !== loadSeq) return;
      data = res;
    } catch (err) {
      if (seq !== loadSeq) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      data = null;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  $effect(() => {
    void reloadToken;
    void load();
  });

  function daysLabel(days: number): string {
    if (days <= 0) return "now";
    if (days < 1) return "<1d";
    if (days < 30) return `~${Math.round(days)}d`;
    return `~${(days / 30.44).toFixed(days < 92 ? 1 : 0)}mo`;
  }

  function rewardValue(row: StockRowDto): string | null {
    if (!row.reward) return null;
    if (row.reward.valuePerPayout !== null) return `~${formatMoneyCompact(row.reward.valuePerPayout)}`;
    if (row.reward.kind === "points" && row.reward.points !== null) return `${formatNumberCompact(row.reward.points)} pts`;
    return null;
  }

  const visibleRows = $derived.by(() => {
    if (!data) return [];
    const rows = data.rows.filter((r) => (view === "owned" ? r.owned : true));
    const missing = (r: StockRowDto): number => (r.timing?.kind === "unavailable" ? 1 : 0);
    const sorters: Record<typeof sort, (a: StockRowDto, b: StockRowDto) => number> = {
      position: (a, b) => (b.positionValue ?? -1) - (a.positionValue ?? -1),
      closest: (a, b) =>
        missing(a) - missing(b) ||
        (a.timing?.daysRemaining ?? Number.MAX_SAFE_INTEGER) - (b.timing?.daysRemaining ?? Number.MAX_SAFE_INTEGER),
      cost: (a, b) => (a.estimatedCostToBenefit ?? Number.MAX_SAFE_INTEGER) - (b.estimatedCostToBenefit ?? Number.MAX_SAFE_INTEGER),
      annual: (a, b) => (b.estimatedAnnualValue ?? -1) - (a.estimatedAnnualValue ?? -1),
      payback: (a, b) => (a.estimatedPaybackDays ?? Number.MAX_SAFE_INTEGER) - (b.estimatedPaybackDays ?? Number.MAX_SAFE_INTEGER),
      name: (a, b) => a.acronym.localeCompare(b.acronym),
    };
    return [...rows].sort(sorters[sort]);
  });

  const upcoming = $derived.by(() => {
    if (!data) return [];
    return data.rows
      .filter((r) => r.owned && r.benefitReached)
      .sort((a, b) => (a.timing?.daysRemaining ?? 999) - (b.timing?.daysRemaining ?? 999));
  });

  function setView(next: typeof view) {
    view = next;
    syncUrl();
  }
  function setSort(next: string) {
    sort = next as typeof sort;
    syncUrl();
  }

  function availabilityState(a: FeatureAvailabilityDto): "permission" | "loading" {
    return a.state === "unavailable_permission" || a.state === "stale_permission" ? "permission" : "loading";
  }

  const YIELD_HELP =
    "Benefit yield estimates the value of this stock's recurring benefit relative to the current value of the shares required for the benefit. It excludes stock price gains or losses.";
  const PAYBACK_HELP = "Payback is an estimate based on current prices and current reward value.";
</script>

<svelte:head><title>Stocks · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Economy · Holdings"
    title="Stocks"
    description="What you own, which benefits are active, and what the next one costs — benefit math is estimated at current prices and never investment advice."
  >
    {#snippet actions()}
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Stock view">
        {#each [["owned", "Owned"], ["all", "All stocks"]] as [value, label] (value)}
          <button
            class="chip cursor-pointer {view === value ? 'chip-accent font-semibold' : 'chip-quiet'}"
            aria-pressed={view === value}
            onclick={() => setView(value as typeof view)}
          >
            {label}
          </button>
        {/each}
      </div>
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load stocks" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data && data.availability.state !== "available_live" && data.availability.state !== "available_historical"}
    <StateMessage
      state={availabilityState(data.availability)}
      title={data.availability.state === "unavailable_permission" || data.availability.state === "stale_permission" ? "Stocks need additional Torn API access" : "Stock data unavailable"}
      hint="Grant the stocks selection on your Torn API key, then review access in Settings."
      action={{ label: "Review API access in Settings", run: () => void goto("/settings") }}
    />
  {:else if data}
    {#if data.summary.stocksOwned === 0}
      <p class="max-w-3xl font-display text-lg leading-relaxed text-fg sm:text-xl">
        No stocks owned yet. Switch to <button class="text-link underline" onclick={() => setView("all")}>All stocks</button>
        to browse benefit blocks and what reaching each one would roughly cost.
      </p>
    {:else}
      <p class="max-w-3xl font-display text-lg leading-relaxed text-fg sm:text-xl">
        <span class="tnum font-semibold">{data.summary.stocksOwned}</span> stock{data.summary.stocksOwned === 1 ? "" : "s"} worth
        <span class="tnum font-semibold">{data.summary.portfolioValue !== null ? formatMoneyCompact(data.summary.portfolioValue) : "—"}</span>
        {#if data.summary.activeBenefits > 0}
          · <span class="tnum font-semibold text-accent">{data.summary.activeBenefits}</span> active benefit{data.summary.activeBenefits === 1 ? "" : "s"}
          {#if data.summary.estimatedAnnualBenefit !== null}
            worth ~{formatMoneyCompact(data.summary.estimatedAnnualBenefit)} a year
          {/if}
          {#if data.summary.unvaluedBenefitCount > 0}
            <span class="text-fg-muted">(estimate excludes {data.summary.unvaluedBenefitCount} non-cash benefit{data.summary.unvaluedBenefitCount === 1 ? "" : "s"})</span>
          {/if}
        {:else}
          · no benefits active yet.
        {/if}
      </p>
    {/if}
    <p class="text-[11px] text-fg-faint">
      Prices and valuations are estimates at the current market price
      {#if data.priceCapturedAt}· captured {formatRelative(data.priceCapturedAt)} ({td.displayDate(data.priceCapturedAt)}){/if}.
    </p>

    {#if upcoming.length > 0}
      <section aria-label="Upcoming stock benefits" class="space-y-2">
        <p class="section-label">Upcoming stock benefits</p>
        <div class="flex flex-wrap gap-2">
          {#each upcoming as row (row.id)}
            <span class="inline-flex items-baseline gap-2 rounded-tile border border-border bg-surface px-3 py-1.5 text-[13px]">
              <span class="font-semibold text-fg">{row.acronym}</span>
              {#if row.timing?.kind === "ready"}
                <span class="text-positive">ready to collect</span>
              {:else if row.timing?.kind === "derived" && row.timing.daysRemaining !== null}
                <span class="tnum text-fg-muted">in {daysLabel(row.timing.daysRemaining)}</span>
              {:else}
                <span class="text-fg-faint">timing unavailable</span>
              {/if}
              {#if rewardValue(row)}
                <span class="tnum text-fg-faint">· {rewardValue(row)}</span>
              {/if}
            </span>
          {/each}
        </div>
      </section>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-1.5 text-xs text-fg-faint">
        <span class="sr-only">Sort stocks</span>
        Sort
        <select class="input !h-8 !w-auto py-0 text-xs" value={sort} onchange={(e) => setSort((e.currentTarget as HTMLSelectElement).value)}>
          <option value="position">Position value</option>
          <option value="closest">Closest next benefit</option>
          <option value="cost">Est. cost to next benefit</option>
          <option value="annual">Est. annual benefit</option>
          <option value="payback">Est. payback</option>
          <option value="name">Name</option>
        </select>
      </label>
    </div>

    <section aria-label="Stock ledger">
      {#if visibleRows.length === 0}
        <StateMessage state="empty" compact title="Nothing here yet" hint={view === "owned" ? "You don't own any stocks yet — switch to All stocks to plan a first position." : "No stocks available."} />
      {:else}
        <div class="overflow-hidden rounded-card border border-border bg-surface shadow-panel">
          <ul class="divide-y divide-border/60">
            {#each visibleRows as row (row.id)}
              {@const isExpanded = expandedId === row.id}
              <li>
                <button
                  type="button"
                  class="flex w-full flex-col gap-2 px-4 py-3.5 text-left transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
                  aria-expanded={isExpanded}
                  onclick={() => (expandedId = isExpanded ? null : row.id)}
                >
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <span class="text-[14px] font-semibold text-fg">{row.acronym}</span>
                      <span class="truncate text-xs text-fg-faint">{row.name}</span>
                      {#if !row.owned}
                        <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">Unowned</span>
                      {:else if row.benefitReached}
                        <span class="chip chip-positive !px-1.5 !text-[9px] !uppercase">Benefit active</span>
                      {:else}
                        <span class="chip chip-warning !px-1.5 !text-[9px] !uppercase">Below block</span>
                      {/if}
                    </span>
                    {#if row.owned && row.shares !== null}
                      <span class="mt-0.5 block text-xs leading-relaxed text-fg-faint">
                        {formatNumberCompact(row.shares)} shares
                        {#if row.positionValue !== null}· ~{formatMoneyCompact(row.positionValue)}{/if}
                      </span>
                    {/if}
                  </span>
                  <span class="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:flex sm:items-center sm:gap-6">
                    <span class="flex flex-col sm:text-right">
                      <span class="text-fg-faint">Next block</span>
                      {#if row.benefitReached}
                        <span class="text-positive">reached</span>
                      {:else if row.missingShares !== null}
                        <span class="tnum text-fg-muted">{formatNumberCompact(row.missingShares)} shares</span>
                      {:else}
                        <span class="text-fg-faint">—</span>
                      {/if}
                    </span>
                    <span class="flex flex-col sm:text-right">
                      <span class="text-fg-faint">Est. cost</span>
                      <span class="tnum text-fg-muted">{row.estimatedCostToBenefit !== null ? `~${formatMoneyCompact(row.estimatedCostToBenefit)}` : "—"}</span>
                    </span>
                    <span class="flex flex-col sm:text-right">
                      <span class="text-fg-faint">Next payout</span>
                      {#if row.timing?.kind === "ready"}
                        <span class="text-positive">ready</span>
                      {:else if row.timing?.kind === "derived" && row.timing.daysRemaining !== null}
                        <span class="tnum text-fg-muted">in {daysLabel(row.timing.daysRemaining)}</span>
                      {:else}
                        <span class="text-fg-faint">unavailable</span>
                      {/if}
                    </span>
                    <span class="flex flex-col sm:text-right">
                      <span class="text-fg-faint">Est. reward</span>
                      <span class="tnum text-fg-muted">{rewardValue(row) ?? "—"}</span>
                    </span>
                  </span>
                  <Icon name={isExpanded ? "chevron-down" : "chevron-right"} size={13} class="hidden text-fg-faint sm:block" />
                </button>
                {#if isExpanded}
                  <div class="border-t border-border/40 bg-bg-raise/40 px-4 py-4 sm:px-5">
                    <div class="grid gap-6 md:grid-cols-2">
                      <div class="space-y-1.5 text-[13px]">
                        <p class="section-label">Benefit</p>
                        <p class="text-fg-muted">{row.benefitDescription ?? "No benefit on this stock"}</p>
                        <p class="text-xs text-fg-faint">
                          Block requires {row.benefitRequirement !== null ? `${formatNumberCompact(row.benefitRequirement)} shares` : "—"}
                          {#if row.benefitFrequencyDays !== null}· pays every {row.benefitFrequencyDays} days{/if}
                        </p>
                        {#if row.owned && row.shares !== null}
                          <p class="text-xs text-fg-faint">
                            You hold {formatNumberCompact(row.shares)} shares
                            {#if row.benefitReached}
                              — block reached{row.timing?.basis ? ` (${row.timing.basis})` : ""}
                            {:else if row.missingShares !== null}
                              — {formatNumberCompact(row.missingShares)} shares short
                            {/if}
                          </p>
                        {/if}
                      </div>
                      <div class="space-y-1.5 text-[13px]">
                        <p class="section-label">Benefit economics <span class="font-normal text-fg-faint">(estimates at current price)</span></p>
                        <dl class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
                          <div>
                            <dt class="text-fg-faint" title={row.reward?.valueIsExact ? "Exact cash amount from Torn" : "Est. value at current catalog price"}>Est. reward value</dt>
                            <dd class="tnum text-fg">{rewardValue(row) ?? "—"}</dd>
                          </div>
                          <div>
                            <dt class="text-fg-faint">Est. annual benefit</dt>
                            <dd class="tnum text-fg">{row.estimatedAnnualValue !== null ? `~${formatMoneyCompact(row.estimatedAnnualValue)}` : "—"}</dd>
                          </div>
                          <div>
                            <dt class="text-fg-faint" title={YIELD_HELP}>Est. yield</dt>
                            <dd class="tnum text-fg">{row.estimatedYieldPct !== null ? `${row.estimatedYieldPct.toFixed(1)}%` : "—"}</dd>
                          </div>
                          <div>
                            <dt class="text-fg-faint" title={PAYBACK_HELP}>Est. payback</dt>
                            <dd class="tnum text-fg">{row.estimatedPaybackDays !== null ? `${daysLabel(row.estimatedPaybackDays)}` : "—"}</dd>
                          </div>
                        </dl>
                        <p class="mt-2.5 text-[11px] leading-relaxed text-fg-faint">
                          {#if row.reward?.valueIsExact}
                            Reward is exact cash from Torn. Yield and payback measure the benefit alone against the required shares' current value — stock price movement is excluded.
                          {:else if row.reward?.valuePerPayout !== null && row.reward !== null}
                            Reward valued at the current catalog price. Yield and payback measure the benefit alone against the required shares' current value — stock price movement is excluded.
                          {:else if row.reward}
                            This reward has no reliable money value, so no yield or payback is claimed.
                          {:else}
                            No benefit defined for this stock.
                          {/if}
                        </p>
                      </div>
                    </div>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
        {#if data.priceCapturedAt}
          <p class="mt-3 text-[11px] text-fg-faint">
            Price as of {td.displayDateTime(data.priceCapturedAt)} · benefit-only economics; never investment advice.
          </p>
        {/if}
      {/if}
    </section>
  {/if}
</div>
