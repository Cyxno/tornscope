<script lang="ts">
  import type { TravelSummaryResponse, TravelTripDto, Paginated } from "@tornscope/shared";
  import { formatMoneyCompact, formatDateTime, formatDuration, formatKpiValue, formatDate } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel } from "$lib/charts";

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

  const destOption = $derived.by(() => {
    if (!summary || summary.profitByDestination.length === 0) return null;
    const rows = summary.profitByDestination.slice(0, 8);
    return {
      tooltip: { ...TOOLTIP, trigger: "axis", axisPointer: { type: "shadow" } },
      grid: GRID,
      xAxis: { type: "value", ...valueAxis() },
      yAxis: {
        type: "category",
        data: rows.map((r) => r.destination),
        axisLabel: { color: C.label, fontSize: 11 },
        axisLine: { lineStyle: { color: C.axisLine } },
        axisTick: { show: false },
      },
      series: [{ type: "bar", data: rows.map((r) => r.profit), barWidth: 12, itemStyle: { color: C.accentStrong, borderRadius: [0, 4, 4, 0] } }],
    };
  });

  const dayOption = $derived.by(() => {
    if (!summary || summary.profitSeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: GRID,
      xAxis: timeAxis(summary.profitSeries.map((p) => dayLabel(p.t))),
      yAxis: valueAxis(),
      series: [{ name: "Estimated profit", type: "bar", data: summary.profitSeries.map((p) => p.profit), barMaxWidth: 12, itemStyle: { color: C.accentStrong, borderRadius: [3, 3, 0, 0] } }],
    };
  });

  /** Friendly haul categories; the pie splits by PURCHASED QUANTITY.
   * Xanax is first-class: a major travel commodity must not hide in Other. */
  const CATEGORY_LABELS: Record<string, string> = { flower: "Flowers", plushie: "Plushies", xanax: "Xanax", other: "Other" };
  const CATEGORY_COLOR: Record<string, string> = { plushie: C.warning, flower: C.pink, xanax: C.violet, other: C.accent };
  const haulOption = $derived.by(() => {
    if (!summary || summary.itemsByCategory.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "item", formatter: (p: { name: string; value: number; percent: number }) => `${p.name}: ${p.value.toLocaleString("en-US")} items (${p.percent}%)` },
      legend: { ...LEGEND, bottom: 0 },
      series: [
        {
          type: "pie",
          radius: ["52%", "76%"],
          center: ["50%", "46%"],
          label: { show: false },
          itemStyle: { borderRadius: 4, borderColor: "#151518", borderWidth: 2 },
          data: summary.itemsByCategory.map((r) => ({
            name: CATEGORY_LABELS[r.category] ?? r.category,
            value: r.quantity,
            itemStyle: { color: CATEGORY_COLOR[r.category] ?? C.accent },
          })),
        },
      ],
    };
  });
</script>

<div class="space-y-10">
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
        <p class="rounded-xl border border-warning/30 bg-warning/5 px-5 py-3 text-xs leading-relaxed text-warning">
          <span class="font-medium">{staleMsg.title}.</span>
          {staleMsg.hint}
        </p>
      {/if}
    {#if summary.coverage.trackingSince !== null}
      <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
        <span class="font-medium text-fg">Full trip data available from Torn:{' '}</span>
        {summary.coverage.completeTripsFrom !== null ? formatDate(summary.coverage.completeTripsFrom) : "—"}
        <span class="mx-2 text-border-strong">·</span>
        <span class="font-medium text-fg">TornScope tracking since:{' '}</span>
        {formatDate(summary.coverage.trackingSince)}
        — trips are stored permanently from that point and do not disappear when Torn prunes its logs.
        {#if dateRange.from !== undefined && dateRange.from < summary.coverage.trackingSince}
          <span class="font-medium text-warning"> The selected range predates complete trip coverage, so it shows partial history — no zeros are invented.</span>
        {/if}
      </p>
    {/if}
    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
      <Stat label="Trips" value={String(summary.trips)} provenance="exact" tone="accent" />
      <Stat
        label="Tracked trip profit"
        value={formatKpiValue(summary.estimatedProfit)}
        provenance="estimated"
        tone={(summary.estimatedProfit.value ?? 0) >= 0 ? "positive" : "negative"}
        sub={summary.estimatedProfit.availability === "incomplete" ? "purchases without a trip exist" : null}
      />
      <Stat label="Profit / hour" value={formatKpiValue(summary.profitPerHour)} provenance="estimated" />
      <Stat label="Top item" value={summary.topItem.item ?? "—"} sub={summary.topItem.profit !== null ? formatMoneyCompact(summary.topItem.profit) : null} provenance="estimated" />
    </div>

    {#if summary.unattachedPurchases.count > 0}
      <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Unmatched purchases:</span>
        {summary.unattachedPurchases.count} abroad purchase{summary.unattachedPurchases.count === 1 ? "" : "s"}
        ({formatMoneyCompact(summary.unattachedPurchases.spend)} across {summary.unattachedPurchases.itemsBought} items) whose
        trip cannot be attached confidently — the departure/arrival logs Torn exposes no longer cover them. The purchases and
        their destinations are kept permanently; they are shown separately and never mixed into Tracked trip profit or
        profit/hour, since their trip duration is unknown.
      </p>
    {/if}

    <section class="grid gap-6 lg:grid-cols-5">
      <div class="lg:col-span-3">
        <Panel title="Profit by destination" caption="Estimated profit, best routes first" flush>
          {#if !destOption}
            <StateMessage state="empty" title="No destinations in this range" />
          {:else}
            <Chart option={destOption} height={300} />
          {/if}
        </Panel>
      </div>
      <div class="lg:col-span-2">
        <Panel title="What you haul" caption="Items bought abroad — plushies, flowers, Xanax and the rest, by quantity" flush>
          {#if !haulOption}
            <StateMessage state="empty" title="No purchases in this range" />
          {:else}
            <Chart option={haulOption} height={280} />
          {/if}
          {#if summary && summary.itemsByCategory.length > 0}
            <div class="border-t border-border px-5 py-3">
              <ul class="space-y-1 text-xs text-fg-muted">
                {#each summary.itemsByCategory as row (row.category)}
                  <li class="flex items-baseline justify-between gap-3">
                    <span>{CATEGORY_LABELS[row.category] ?? row.category}</span>
                    <span class="tnum">
                      {formatMoneyCompact(row.spend)} spend
                      {#if row.estimatedValue !== null}
                        · {formatMoneyCompact(row.estimatedValue)} est. value
                      {/if}
                    </span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if summary && summary.topItems.length > 0}
            <div class="border-t border-border px-5 py-3">
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
    </section>

    <Panel title="Profit by departure day" caption="Days you flew out, ranked by what came back" flush>
      {#if !dayOption}
        <StateMessage state="empty" title="No departures in this range" />
      {:else}
        <Chart option={dayOption} height={280} />
      {/if}
    </Panel>

    <!-- Trip history -->
    <Panel title="Trip log" caption="Select a row to unfold the haul" flush>
      {#if !history || history.items.length === 0}
        <div class="px-6 pb-6 pt-2">
          <StateMessage state={histBlocked && histAv ? availabilityMessage(histAv).state : "empty"} title={histBlocked && histAv ? availabilityMessage(histAv).title : "No trips recorded in this range yet"} hint={histBlocked && histAv ? availabilityMessage(histAv).hint : "Trips assemble automatically from travel logs and item purchases."} />
        </div>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2.5 pl-6 pr-4 font-medium">Departed</th>
                <th class="py-2.5 pr-4 font-medium">Destination</th>
                <th class="py-2.5 pr-4 text-right font-medium">Duration</th>
                <th class="py-2.5 pr-4 text-right font-medium">Items</th>
                <th class="py-2.5 pr-4 text-right font-medium">Spend</th>
                <th class="py-2.5 pr-6 text-right font-medium">Est. profit</th>
              </tr>
            </thead>
            <tbody>
              {#each history.items as trip (trip.id)}
                <tr class="cursor-pointer border-b border-border/50 transition-colors hover:bg-surface-2/50" onclick={() => toggle(trip.id)}>
                  <td class="tnum whitespace-nowrap py-3 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(trip.departedAt)}</td>
                  <td class="py-3 pr-4">
                    <span class="font-medium text-fg">{trip.destination}</span>
                    {#if trip.returnedAt === null}
                      <span class="ml-2 inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                        <span class="live-dot h-1 w-1 rounded-full bg-accent"></span>
                        in flight
                      </span>
                    {/if}
                  </td>
                  <td class="tnum py-3 pr-4 text-right text-fg-muted">{formatDuration(trip.durationSeconds)}</td>
                  <td class="tnum py-3 pr-4 text-right text-fg-muted">{trip.itemsBought}</td>
                  <td class="tnum py-3 pr-4 text-right text-fg-muted">{formatMoneyCompact(-trip.spend)}</td>
                  <td class="tnum py-3 pr-6 text-right font-semibold {(trip.estimatedProfit ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">
                    {trip.estimatedProfit !== null ? formatMoneyCompact(trip.estimatedProfit) : "—"}
                  </td>
                </tr>
                {#if expanded.has(trip.id) && trip.items.length > 0}
                  <tr class="border-b border-border/50 bg-bg-raise">
                    <td colspan="6" class="p-0">
                      <div class="px-6 py-4">
                        <table class="w-full text-left text-xs">
                          <thead>
                            <tr class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">
                              <th class="py-1.5 pr-4 font-medium">Item</th>
                              <th class="py-1.5 pr-4 font-medium">Category</th>
                              <th class="py-1.5 pr-4 text-right font-medium">Qty</th>
                              <th class="py-1.5 pr-4 text-right font-medium">Unit cost</th>
                              <th class="py-1.5 pr-4 text-right font-medium">Est. unit value</th>
                              <th class="py-1.5 text-right font-medium">Est. profit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {#each trip.items as item (item.id)}
                              <tr class="border-t border-border/40">
                                <td class="py-1.5 pr-4 text-fg">{item.itemName}</td>
                                <td class="py-1.5 pr-4 capitalize text-fg-muted">{item.category}</td>
                                <td class="tnum py-1.5 pr-4 text-right text-fg-muted">{item.quantity}</td>
                                <td class="tnum py-1.5 pr-4 text-right text-fg-muted">{formatMoneyCompact(item.unitCost)}</td>
                                <td class="tnum py-1.5 pr-4 text-right text-fg-muted">{item.estimatedUnitValue !== null ? formatMoneyCompact(item.estimatedUnitValue) : "—"}</td>
                                <td class="tnum py-1.5 text-right font-medium {(item.estimatedProfit ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">
                                  {item.estimatedProfit !== null ? formatMoneyCompact(item.estimatedProfit) : "—"}
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
      {/if}
    </Panel>
    {/if}
  {/if}
</div>
