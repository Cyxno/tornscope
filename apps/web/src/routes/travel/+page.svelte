<script lang="ts">
  import type { TravelSummaryResponse, TravelTripDto, Paginated } from "@tornscope/shared";
  import { formatMoneyCompact, formatDateTime, formatDuration, formatKpiValue, formatDate, formatSignedMoneyCompact } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, TOOLTIP, GRID, timeAxis, valueAxis, dayLabel, MOTION } from "$lib/charts";

  let summary = $state<TravelSummaryResponse | null>(null);
  let history = $state<Paginated<TravelTripDto> | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);
  let expanded = $state<Set<string>>(new Set());

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const [s, h] = await Promise.all([endpoints.travelSummary(range), endpoints.travelHistory(range)]);
      summary = s;
      history = h;
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

  /** Friendly haul categories. Xanax is first-class: a major travel
   * commodity must not hide in Other. */
  const CATEGORY_LABELS: Record<string, string> = { flower: "Flowers", plushie: "Plushies", xanax: "Xanax", other: "Other" };
  const CATEGORY_COLOR: Record<string, string> = { plushie: C.warning, flower: C.pink, xanax: C.violet, other: C.accent };

  /** Destination ranking rows: the primary visual. Signed bars share the
   * scale of the largest absolute estimated profit. */
  const destRows = $derived.by(() => {
    if (!summary) return [];
    const rows = [...summary.profitByDestination].sort((a, b) => b.profit - a.profit);
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.profit)));
    return rows.map((r) => ({ ...r, width: Math.max(3, (Math.abs(r.profit) / max) * 100), positive: r.profit >= 0 }));
  });

  /** Haul category rows: quantity-share bars instead of a donut. */
  const haulCategories = $derived.by(() => {
    if (!summary) return [];
    const max = Math.max(1, ...summary.itemsByCategory.map((r) => r.quantity));
    return summary.itemsByCategory.map((r) => ({
      ...r,
      label: CATEGORY_LABELS[r.category] ?? r.category,
      color: CATEGORY_COLOR[r.category] ?? C.accent,
      width: Math.max(3, (r.quantity / max) * 100),
    }));
  });

  const dayOption = $derived.by(() => {
    if (!summary || summary.profitSeries.length === 0) return null;
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: GRID,
      xAxis: timeAxis(summary.profitSeries.map((p) => dayLabel(p.t)), { boundaryGap: true }),
      yAxis: valueAxis(),
      series: [{ name: "Estimated profit", type: "bar", data: summary.profitSeries.map((p) => p.profit), barMaxWidth: 12, itemStyle: { color: C.accentStrong, borderRadius: 3 } }],
    };
  });

  /** Trip haul mini-table shared by the desktop expansion row and the
   * mobile card expansion. */
  function haulRows(trip: TravelTripDto) {
    return trip.items;
  }
</script>

<svelte:head><title>Travel · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Travel · Trading"
    title="Routes & profit"
    description="Every flight, every plushie and flower haul — with profitability estimated from Torn market prices, never passed off as exact."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !summary}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load travel analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if summary}
    {@const histAv = summary.availability?.history}
    {@const histBlocked = histAv !== undefined && !availabilityHasData(histAv)}
    {@const staleMsg = histAv && histAv.state === "stale_permission" ? availabilityMessage(histAv) : null}
    {#if histBlocked && histAv}
      <!-- Permission-unavailable: never render as zeros or "No trips" -->
      <StateMessage
        state={availabilityMessage(histAv).state}
        title={availabilityMessage(histAv).title}
        hint={availabilityMessage(histAv).hint}
        action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
      />
    {:else}
      {#if staleMsg}
        <p class="rounded-tile border border-warning/30 bg-warning/5 px-5 py-3 text-xs leading-relaxed text-warning">
          <span class="font-medium">{staleMsg.title}.</span>
          {staleMsg.hint}
        </p>
      {/if}
      {#if summary.coverage.trackingSince !== null}
        <details class="group rounded-tile border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
          <summary class="flex cursor-pointer items-center justify-between gap-3 font-medium text-fg transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
            Trip data coverage
            <span class="transition-transform group-open:rotate-180">▾</span>
          </summary>
          <p class="mt-2.5 border-t border-border pt-2.5">
            Full trip data available from Torn: {summary.coverage.completeTripsFrom !== null ? formatDate(summary.coverage.completeTripsFrom) : "—"}
            <span class="mx-2 text-border-strong">·</span>
            TornScope tracking since: {formatDate(summary.coverage.trackingSince)}
            — trips are stored permanently from that point and do not disappear when Torn prunes its logs.
            {#if dateRange.from !== undefined && dateRange.from < summary.coverage.trackingSince}
              <span class="font-medium text-warning"> The selected range predates complete trip coverage, so it shows partial history — no zeros are invented.</span>
            {/if}
          </p>
        </details>
      {/if}

      <!-- Estimate block: the page's hero figure, on open canvas -->
      <section class="section-rule" aria-label="Estimated profit">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p class="section-label">Tracked trip profit</p>
          <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-warning">estimated</span>
        </div>
        <p class="hero-num tnum mt-3 {summary.estimatedProfit.value === null ? 'text-fg-faint' : summary.estimatedProfit.value >= 0 ? 'text-positive' : 'text-negative'}">
          {formatKpiValue(summary.estimatedProfit, formatSignedMoneyCompact)}
        </p>
        <dl class="mt-6 grid grid-cols-2 gap-y-5 md:grid-cols-3 md:divide-x md:divide-border">
          <div class="md:pr-6">
            <dt class="text-[11px] font-medium text-fg-faint">Trips</dt>
            <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{summary.trips}</dd>
          </div>
          <div class="md:px-6">
            <dt class="text-[11px] font-medium text-fg-faint">Profit / hour <span class="text-warning">est.</span></dt>
            <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{formatKpiValue(summary.profitPerHour, formatSignedMoneyCompact)}</dd>
          </div>
          <div class="md:pl-6">
            <dt class="text-[11px] font-medium text-fg-faint">Top item <span class="text-warning">est.</span></dt>
            <dd class="mt-1 truncate text-[22px] font-semibold text-fg" title={summary.topItem.item ?? ""}>{summary.topItem.item ?? "—"}</dd>
            {#if summary.topItem.profit !== null}
              <dd class="tnum text-[11px] {summary.topItem.profit >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedMoneyCompact(summary.topItem.profit)}</dd>
            {/if}
          </div>
        </dl>
        {#if summary.estimatedProfit.availability === "incomplete"}
          <p class="mt-3 text-[11px] text-warning">Some purchases exist without an attachable trip — they are excluded from tracked profit, never mixed in.</p>
        {/if}
      </section>

      <!-- Destination ranking: the primary visual, on open canvas -->
      <section class="section-rule" aria-label="Destinations">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="section-label">Destinations — ranked by estimated profit</h2>
          <span class="text-[11px] text-fg-faint">bar length = |profit|</span>
        </div>
        {#if destRows.length === 0}
          <p class="mt-4 text-[13px] text-fg-faint">No destinations in this range yet.</p>
        {:else}
          <ul class="mt-3 divide-y divide-border/70">
            {#each destRows as dest (dest.destination)}
              <li class="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)_auto_auto]">
                <span class="text-[13.5px] font-medium text-fg">{dest.destination}</span>
                <span class="hidden items-center sm:flex" aria-hidden="true">
                  <span class="flex h-4 w-full items-center">
                    <span class="flex w-1/2 justify-end">
                      {#if !dest.positive}
                        <span class="delta-bar bg-negative/70" style="width: {dest.width}%"></span>
                      {/if}
                    </span>
                    <span class="h-3 w-px bg-border-strong"></span>
                    <span class="flex w-1/2">
                      {#if dest.positive}
                        <span class="delta-bar bg-accent/80" style="width: {dest.width}%"></span>
                      {/if}
                    </span>
                  </span>
                </span>
                <span class="tnum text-right text-xs text-fg-faint">{dest.trips} trip{dest.trips === 1 ? "" : "s"}</span>
                <span class="tnum text-right text-[13.5px] font-semibold {dest.positive ? 'text-positive' : 'text-negative'}">{formatSignedMoneyCompact(dest.profit)}</span>
              </li>
            {/each}
          </ul>
          <p class="mt-2 text-[11px] text-fg-faint">
            Profit per destination is estimated from current catalog prices at trip time — a reading, not a realized profit or loss.
          </p>
        {/if}
      </section>

      {#if summary.unattachedPurchases.count > 0}
        <details class="group rounded-tile border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
          <summary class="flex cursor-pointer items-center justify-between gap-3 text-fg transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
            {summary.unattachedPurchases.count} unmatched abroad purchase{summary.unattachedPurchases.count === 1 ? "" : "s"}
            <span class="tnum font-normal text-fg-muted">{formatMoneyCompact(summary.unattachedPurchases.spend)}</span>
          </summary>
          <p class="mt-2.5 border-t border-border pt-2.5">
            ({formatMoneyCompact(summary.unattachedPurchases.spend)} across {summary.unattachedPurchases.itemsBought} items) whose
            trip cannot be attached confidently — the departure/arrival logs Torn exposes no longer cover them. The purchases and
            their destinations are kept permanently; they are shown separately and never mixed into Tracked trip profit or
            profit/hour, since their trip duration is unknown.
          </p>
        </details>
      {/if}

      <section class="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div class="min-w-0 lg:col-span-2">
          <Panel title="What you haul" caption="Items bought abroad — by quantity, valued from the catalog">
            {#if haulCategories.length === 0}
              <StateMessage state="empty" compact title="No purchases in this range" />
            {:else}
              <ul class="space-y-4">
                {#each haulCategories as row (row.category)}
                  <li>
                    <div class="flex items-baseline justify-between gap-3 text-[13px]">
                      <span class="text-fg">{row.label} <span class="text-[11px] text-fg-faint">{row.quantity} item{row.quantity === 1 ? "" : "s"}</span></span>
                      <span class="tnum text-xs text-fg-muted">
                        {formatMoneyCompact(row.spend)} spend
                        {#if row.estimatedValue !== null}
                          · {formatMoneyCompact(row.estimatedValue)} est. value
                        {/if}
                      </span>
                    </div>
                    <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div class="h-full rounded-full" style="width: {row.width}%; background: {row.color}"></div>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if summary.topItems.length > 0}
              <div class="mt-5 border-t border-border pt-4">
                <p class="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Top items by spend</p>
                <ul class="space-y-1 text-xs text-fg-muted">
                  {#each summary.topItems as row (row.item)}
                    <li class="flex items-baseline justify-between gap-3">
                      <span class="text-fg">{row.item} <span class="text-fg-faint">({CATEGORY_LABELS[row.category] ?? row.category})</span></span>
                      <span class="tnum">
                        {Math.round(row.spendShare * 100)}% of spend · {row.quantity}×
                        {#if row.estimatedProfit !== null}
                          · <span class={row.estimatedProfit >= 0 ? "text-positive" : "text-negative"}>{formatMoneyCompact(row.estimatedProfit)}</span>
                        {/if}
                      </span>
                    </li>
                  {/each}
                </ul>
                <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
                  Estimated values use Torn market prices (conservative, same semantics as other travel goods). Xanax you
                  consume personally is tracked under Drugs — this section is travel merchandise only.
                </p>
              </div>
            {/if}
          </Panel>
        </div>
        <div class="min-w-0 lg:col-span-3">
          <Panel title="Profit by departure day" caption="Days you flew out, ranked by what came back" flush>
            {#if !dayOption}
              <StateMessage state="empty" compact title="No departures in this range" />
            {:else}
              <Chart option={dayOption} height={280} />
            {/if}
          </Panel>
        </div>
      </section>

      <!-- Trip log: table on md+, cards on phones -->
      <Panel title="Trip log" caption="Select a row to unfold the haul" flush>
        {#if !history || history.items.length === 0}
          <div class="px-6 pb-6 pt-2">
            <StateMessage state={histBlocked && histAv ? availabilityMessage(histAv).state : "empty"} title={histBlocked && histAv ? availabilityMessage(histAv).title : "No trips recorded in this range yet"} hint={histBlocked && histAv ? availabilityMessage(histAv).hint : "Trips assemble automatically from travel logs and item purchases."} />
          </div>
        {:else}
          <!-- Desktop / tablet table -->
          <div class="hidden overflow-x-auto md:block">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>Departed</th>
                  <th>Destination</th>
                  <th class="text-right">Duration</th>
                  <th class="text-right">Items</th>
                  <th class="text-right">Spend</th>
                  <th class="text-right">Est. profit</th>
                </tr>
              </thead>
              <tbody>
                {#each history.items as trip (trip.id)}
                  <tr class="cursor-pointer" onclick={() => toggle(trip.id)}>
                    <td class="tnum whitespace-nowrap text-xs text-fg-faint">{formatDateTime(trip.departedAt)}</td>
                    <td>
                      <span class="font-medium text-fg">{trip.destination}</span>
                      {#if trip.returnedAt === null}
                        <span class="chip chip-accent ml-2 !px-1.5 !text-[10px]">
                          <span class="live-dot h-1 w-1 rounded-full bg-accent"></span>
                          in flight
                        </span>
                      {/if}
                    </td>
                    <td class="tnum text-right text-fg-muted">{formatDuration(trip.durationSeconds)}</td>
                    <td class="tnum text-right text-fg-muted">{trip.itemsBought}</td>
                    <td class="tnum text-right text-fg-muted">{formatMoneyCompact(-trip.spend)}</td>
                    <td class="tnum text-right font-semibold {trip.estimatedProfit === null ? 'text-fg-faint' : trip.estimatedProfit >= 0 ? 'text-positive' : 'text-negative'}">
                      {trip.estimatedProfit !== null ? formatSignedMoneyCompact(trip.estimatedProfit) : "—"}
                    </td>
                  </tr>
                  {#if expanded.has(trip.id) && haulRows(trip).length > 0}
                    <tr class="bg-bg-raise">
                      <td colspan="6" class="p-0">
                        <div class="px-6 py-4">
                          <table class="tsv-table !text-xs">
                            <thead>
                              <tr class="[&>th]:!text-[9px]">
                                <th>Item</th>
                                <th>Category</th>
                                <th class="text-right">Qty</th>
                                <th class="text-right">Unit cost</th>
                                <th class="text-right">Est. unit value</th>
                                <th class="text-right">Est. profit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {#each trip.items as item (item.id)}
                                <tr class="[&>td]:!border-t [&>td]:!border-border/40">
                                  <td class="text-fg">{item.itemName}</td>
                                  <td class="text-fg-muted">{CATEGORY_LABELS[item.category] ?? item.category}</td>
                                  <td class="tnum text-right text-fg-muted">{item.quantity}</td>
                                  <td class="tnum text-right text-fg-muted">{formatMoneyCompact(item.unitCost)}</td>
                                  <td class="tnum text-right text-fg-muted">{item.estimatedUnitValue !== null ? formatMoneyCompact(item.estimatedUnitValue) : "—"}</td>
                                  <td class="tnum text-right font-medium {item.estimatedProfit === null ? 'text-fg-faint' : item.estimatedProfit >= 0 ? 'text-positive' : 'text-negative'}">
                                    {item.estimatedProfit !== null ? formatSignedMoneyCompact(item.estimatedProfit) : "—"}
                                  </td>
                                </tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          </div>

          <!-- Mobile card list -->
          <div class="divide-y divide-border md:hidden">
            {#each history.items as trip (trip.id)}
              <div class="px-5 py-4">
                <button type="button" class="flex w-full flex-col gap-2 text-left" onclick={() => toggle(trip.id)}>
                  <div class="flex items-baseline justify-between gap-3">
                    <span class="font-medium text-fg">{trip.destination}</span>
                    <span class="tnum text-sm font-semibold {trip.estimatedProfit === null ? 'text-fg-faint' : trip.estimatedProfit >= 0 ? 'text-positive' : 'text-negative'}">
                      {trip.estimatedProfit !== null ? formatSignedMoneyCompact(trip.estimatedProfit) : "—"}
                    </span>
                  </div>
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-fg-faint">
                    <span class="tnum">{formatDateTime(trip.departedAt)}</span>
                    <span>{formatDuration(trip.durationSeconds)}</span>
                    <span>{trip.itemsBought} items</span>
                    <span class="tnum">{formatMoneyCompact(-trip.spend)}</span>
                    {#if trip.returnedAt === null}
                      <span class="chip chip-accent !px-1.5 !text-[10px]"><span class="live-dot h-1 w-1 rounded-full bg-accent"></span> in flight</span>
                    {/if}
                  </div>
                </button>
                {#if expanded.has(trip.id) && haulRows(trip).length > 0}
                  <ul class="mt-3 space-y-1.5 rounded-tile border border-border bg-bg-raise p-3 text-xs">
                    {#each trip.items as item (item.id)}
                      <li class="flex items-baseline justify-between gap-3">
                        <span class="min-w-0 truncate text-fg">{item.itemName} <span class="tnum text-fg-faint">×{item.quantity}</span></span>
                        <span class="tnum shrink-0 {item.estimatedProfit === null ? 'text-fg-faint' : item.estimatedProfit >= 0 ? 'text-positive' : 'text-negative'}">
                          {item.estimatedProfit !== null ? formatSignedMoneyCompact(item.estimatedProfit) : "—"}
                        </span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </Panel>
    {/if}
  {/if}
</div>
