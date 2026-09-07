<script lang="ts">
  import type { CrimesSummaryResponse, CrimesTimelineResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatDateTime, formatSignedMoney, periodLabel, formatDate } from "@tornscope/shared";
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

  let summary = $state<CrimesSummaryResponse | null>(null);
  let timeline = $state<CrimesTimelineResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  // Permission gate: crimes history is reconstructed from personal logs.
  const histAv = $derived(summary?.availability?.history);
  const histBlocked = $derived(histAv !== undefined && !availabilityHasData(histAv));
  const histMsg = $derived(histAv ? availabilityMessage(histAv) : null);

  async function load() {
    loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      summary = await endpoints.crimesSummary(range);
      timeline = await endpoints.crimesTimeline(range);
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

  const period = $derived(periodLabel(dateRange.preset));

  const trendOption = $derived.by(() => {
    if (!summary || summary.dailySeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: ["Attempts", "Successes"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(summary.dailySeries.map((p) => dayLabel(p.t))),
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: C.label, fontSize: 10.5 }, splitLine: { lineStyle: { color: C.splitLine } }, axisLine: { show: false } },
      series: [
        { name: "Attempts", type: "bar", data: summary.dailySeries.map((p) => p.attempts), barMaxWidth: 12, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
        { name: "Successes", type: "bar", data: summary.dailySeries.map((p) => p.successes), barMaxWidth: 12, itemStyle: { color: C.positive, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });

  const valueOption = $derived.by(() => {
    if (!summary || summary.dailySeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: GRID,
      xAxis: timeAxis(summary.dailySeries.map((p) => dayLabel(p.t))),
      yAxis: valueAxis(),
      series: [
        {
          name: "Crime value",
          type: "line",
          data: summary.dailySeries.map((p) => p.value),
          showSymbol: summary.dailySeries.length < 40,
          smooth: 0.25,
          lineStyle: { color: C.accentStrong, width: 2 },
        },
      ],
    };
  });
</script>

<div class="space-y-10">
  <PageHeader
    eyebrow="Crime"
    title="Crimes"
    description="Every attempt from your Torn crime logs — exact cash, catalog-estimated item rewards, honest success rates."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !summary}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load crimes analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if summary}
    {#if histBlocked && histAv}
      <!-- Crimes need User Logs: a permission state, never zeros -->
      <StateMessage
        state={histMsg!.state}
        title={histMsg!.title}
        hint={histMsg!.hint}
        action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
      />
    {:else}
    {#if summary.coverage.trackingSince !== null}
      <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Tracking since {formatDate(summary.coverage.trackingSince)}</span>
        — crime attempts are normalized from your permanently stored raw logs; older history Torn no longer returns is never invented.
      </p>
    {/if}

    <!-- Hero: the three numbers that matter most -->
    <div class="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-3">
      <div class="bg-surface p-7 text-center">
        <p class="tnum text-4xl font-semibold text-fg">{summary.attempts}</p>
        <p class="mt-1 text-[11px] uppercase tracking-[0.14em] text-fg-faint">attempts {summary.crimesPerDay ? `· ${summary.crimesPerDay.toFixed(1)}/day` : ""}</p>
      </div>
      <div class="bg-surface p-7 text-center">
        <p class="tnum text-4xl font-semibold text-positive">{summary.successRate !== null ? `${Math.round(summary.successRate * 100)}%` : "—"}</p>
        <p class="mt-1 text-[11px] uppercase tracking-[0.14em] text-fg-faint">success rate · {summary.successful}W / {summary.failed}F</p>
      </div>
      <div class="bg-surface p-7 text-center">
        <p class="tnum text-4xl font-semibold {summary.netCrimeCash >= 0 ? "text-positive" : "text-negative"}">{formatSignedMoney(summary.netCrimeCash)}</p>
        <p class="mt-1 text-[11px] uppercase tracking-[0.14em] text-fg-faint">net crime cash · exact</p>
      </div>
    </div>

    <!-- Secondary strip: clearly-estimated + context values -->
    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
      <Stat label="Item rewards (est.)" value={summary.estimatedItemsValue !== null ? formatMoneyCompact(summary.estimatedItemsValue) : "—"} provenance="estimated" sub="Torn catalog prices" />
      <Stat label="Nerve used" value={summary.nerveUsed !== null ? String(summary.nerveUsed) : "—"} provenance="exact" />
      <Stat label="Value per nerve (est.)" value={summary.valuePerNerve !== null ? formatMoneyCompact(summary.valuePerNerve) : "—"} provenance="estimated" />
      <Stat label="Jail time" value={summary.jailedCount > 0 ? `${summary.jailedCount}× · ${Math.round(summary.totalJailSeconds / 3600)}h` : "0×"} provenance="exact" tone={summary.jailedCount > 0 ? "negative" : "neutral"} />
    </div>

    <p class="text-xs text-fg-faint">
      Cash figures are <span class="font-medium text-fg">exact</span> from your Torn logs; item reward values are
      <span class="font-medium text-warning">estimates</span> from the Torn item catalog and are never mixed into the exact cash total.
    </p>

    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Attempts & successes" caption="Per day over the selected range" flush>
        {#if !trendOption}
          <StateMessage state="empty" title="No crime attempts in this range" />
        {:else}
          <Chart option={trendOption} height={280} />
        {/if}
      </Panel>
      <Panel title="Crime value" caption="Cash + estimated item rewards per day" flush>
        {#if !valueOption}
          <StateMessage state="empty" title="No crime value in this range" />
        {:else}
          <Chart option={valueOption} height={280} />
        {/if}
      </Panel>
    </section>

    {#if summary.jailedCount > 0}
      <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Jailed from crimes:</span>
        {summary.jailedCount} time{summary.jailedCount === 1 ? "" : "s"} this range,
        {Math.round(summary.totalJailSeconds / 3600)}h total jail time (Torn-reported jail seconds).
      </p>
    {/if}

    <Panel title="By crime" caption="Ranked by attempts — cash exact, items (est.) from catalog prices" flush>
      {#if summary.byCrime.length === 0}
        <StateMessage state="empty" title="No crime attempts in this range" />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2.5 pl-6 pr-4 font-medium">Crime</th>
                <th class="py-2.5 pr-4 text-right font-medium">Att.</th>
                <th class="py-2.5 pr-4 text-right font-medium">Rate</th>
                <th class="py-2.5 pr-4 text-right font-medium">Cash in</th>
                <th class="py-2.5 pr-4 text-right font-medium">Cash out</th>
                <th class="py-2.5 pr-4 text-right font-medium">Items (est.)</th>
                <th class="py-2.5 pr-4 text-right font-medium">Nerve</th>
                <th class="py-2.5 pr-6 text-right font-medium">Per nerve</th>
              </tr>
            </thead>
            <tbody>
              {#each summary.byCrime.slice(0, 12) as row, i (row.crime)}
                <tr class="border-b border-border/50 last:border-0 transition-colors hover:bg-surface-2/50 {i % 2 === 1 ? 'bg-surface-2/30' : ''}">
                  <td class="max-w-[240px] truncate py-2.5 pl-6 pr-4 font-medium text-fg" title={row.crime}>{row.crime}</td>
                  <td class="tnum py-2.5 pr-4 text-right font-semibold text-fg">{row.attempts}</td>
                  <td class="tnum py-2.5 pr-4 text-right {row.successRate !== null && row.successRate >= 0.5 ? 'text-positive' : 'text-fg-muted'}">{row.successRate !== null ? `${Math.round(row.successRate * 100)}%` : "—"}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-positive">{row.cashGained > 0 ? formatMoneyCompact(row.cashGained) : "—"}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-negative">{row.cashLost > 0 ? formatMoneyCompact(row.cashLost) : "—"}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-warning">{row.estimatedItemsValue !== null ? formatMoneyCompact(row.estimatedItemsValue) : "—"}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{row.nerveUsed ?? "—"}</td>
                  <td class="tnum py-2.5 pr-6 text-right text-warning">{row.valuePerNerve !== null ? formatMoneyCompact(row.valuePerNerve) : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Panel>

    <Panel title="Crime log" caption="Newest attempts first — exact values from your logs" flush>
      {#if !timeline || timeline.items.length === 0}
        <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="No crime attempts in this range" /></div>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2.5 pl-6 pr-4 font-medium">When</th>
                <th class="py-2.5 pr-4 font-medium">Crime</th>
                <th class="py-2.5 pr-4 font-medium">Outcome</th>
                <th class="py-2.5 pr-4 text-right font-medium">Nerve</th>
                <th class="py-2.5 pr-4 text-right font-medium">Cash</th>
                <th class="py-2.5 pr-6 text-right font-medium">Est. items</th>
              </tr>
            </thead>
            <tbody>
              {#each timeline.items as ev (ev.id)}
                <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                  <td class="tnum whitespace-nowrap py-2.5 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(ev.occurredAt)}</td>
                  <td class="max-w-[260px] truncate py-2.5 pr-4 text-fg" title={ev.crimeName ?? ""}>{ev.crimeName ?? "Unknown crime"}</td>
                  <td class="py-2.5 pr-4">
                    <span class={`rounded-full border px-2 py-0.5 text-[11px] ${ev.success ? "border-positive/30 bg-positive/10 text-positive" : "border-negative/30 bg-negative/10 text-negative"}`}>
                      {ev.success ? "Success" : "Failed"}
                    </span>
                  </td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{ev.nerveUsed ?? "—"}</td>
                  <td class="tnum py-2.5 pr-4 text-right {ev.moneyDelta !== null ? (ev.moneyDelta >= 0 ? 'text-positive' : 'text-negative') : 'text-fg-faint'}">
                    {ev.moneyDelta !== null ? formatSignedMoney(ev.moneyDelta) : "—"}
                  </td>
                  <td class="tnum py-2.5 pr-6 text-right text-fg-muted">{ev.itemsValue !== null ? formatMoneyCompact(ev.itemsValue) : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Panel>
    {/if}
  {/if}
</div>
