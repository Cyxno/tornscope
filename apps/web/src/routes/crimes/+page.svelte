<script lang="ts">
  import { createLoadGuard } from "$lib/loadGuard";
  import { goto } from "$app/navigation";
  import type { CrimesSummaryResponse, CrimesTimelineResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoney, formatSignedMoneyCompact, periodLabel } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, LEGEND, GRID, timeAxis, valueAxis, moneyValueAxis, moneyTooltipValue, dayLabel, axisTimeTooltip } from "$lib/charts";
  import * as td from "$lib/time-display.svelte.js";

  let summary = $state<CrimesSummaryResponse | null>(null);
  let timeline = $state<CrimesTimelineResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  /** One compact line per non-cash reward component: "3× Banana (est. $120)".
   *  Estimated value only where the catalog prices it; unpriced stays visible
   *  as "unpriced" — never $0, never mixed into exact cash. */
  function otherRewardLine(rewards: CrimesTimelineResponse["items"][number]["otherRewards"]): string {
    return rewards
      .map((r) => `${r.quantity > 1 ? `${r.quantity}× ` : ""}${r.label}${r.valuation === "estimated" ? ` (est. ${formatMoneyCompact(r.valueEstimate!)})` : " (unpriced)"}`)
      .join(", ");
  }

  // Permission gate: crimes history is reconstructed from personal logs.
  const histAv = $derived(summary?.availability?.history);
  const histBlocked = $derived(histAv !== undefined && !availabilityHasData(histAv));
  const histMsg = $derived(histAv ? availabilityMessage(histAv) : null);

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const [s, t] = await Promise.all([endpoints.crimesSummary(range), endpoints.crimesTimeline(range)]);
      if (!guard.isCurrent(seq)) return; // a newer range superseded this response
      summary = s;
      timeline = t;
    } catch (err) {
      if (!guard.isCurrent(seq)) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      if (guard.isCurrent(seq)) loading = false;
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
      tooltip: axisTimeTooltip(summary.dailySeries.map((p) => p.t)),
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
      tooltip: axisTimeTooltip(summary.dailySeries.map((p) => p.t), moneyTooltipValue()),
      grid: GRID,
      xAxis: timeAxis(summary.dailySeries.map((p) => dayLabel(p.t))),
      yAxis: moneyValueAxis(),
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

<svelte:head><title>Crimes · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
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
        action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
      />
    {:else}
    {#if summary.coverage.trackingSince !== null}
      <p class="rounded-tile border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Tracking since {td.displayDate(summary.coverage.trackingSince)}</span>
        — crime attempts are normalized from your permanently stored raw logs; older history Torn no longer returns is never invented.
      </p>
    {/if}

    <!-- Hero: the three numbers, on the open canvas -->
    <section class="section-rule" aria-label="Crime summary">
      <dl class="grid grid-cols-1 gap-y-6 md:grid-cols-3 md:divide-x md:divide-border">
        <div class="md:pr-8">
          <dt class="text-[11px] font-medium text-fg-faint">Attempts {summary.crimesPerDay ? `· ${summary.crimesPerDay.toFixed(1)}/day` : ""}</dt>
          <dd class="tnum mt-1 text-[40px] font-semibold leading-none text-fg">{summary.attempts}</dd>
        </div>
        <div class="md:px-8">
          <dt class="text-[11px] font-medium text-fg-faint">Success rate · {summary.successful} successful · {summary.failed} failed</dt>
          <dd class="tnum mt-1 text-[40px] font-semibold leading-none text-positive">{summary.successRate !== null ? `${Math.round(summary.successRate * 100)}%` : "—"}</dd>
        </div>
        <div class="md:pl-8">
          <dt class="text-[11px] font-medium text-fg-faint">Net crime cash · exact</dt>
          <dd class="tnum mt-1 text-[40px] font-semibold leading-none {summary.netCrimeCash >= 0 ? "text-positive" : "text-negative"}">{formatSignedMoneyCompact(summary.netCrimeCash)}</dd>
        </div>
      </dl>
      <dl class="mt-8 grid grid-cols-2 gap-y-5 border-t border-border pt-5 md:grid-cols-4 md:divide-x md:divide-border">
        <div class="md:pr-5">
          <dt class="text-[11px] font-medium text-fg-faint">Item rewards <span class="text-warning">est.</span></dt>
          <dd class="tnum mt-1 text-[20px] font-semibold text-fg">{summary.estimatedItemsValue !== null ? formatMoneyCompact(summary.estimatedItemsValue) : "—"}</dd>
          <dd class="text-[11px] text-fg-faint">Torn catalog prices</dd>
        </div>
        <div class="md:px-5">
          <dt class="text-[11px] font-medium text-fg-faint">Nerve used</dt>
          <dd class="tnum mt-1 text-[20px] font-semibold text-fg">{summary.nerveUsed !== null ? summary.nerveUsed : "—"}</dd>
        </div>
        <div class="md:px-5">
          <dt class="text-[11px] font-medium text-fg-faint">Value per nerve <span class="text-warning">est.</span></dt>
          <dd class="tnum mt-1 text-[20px] font-semibold text-fg">{summary.valuePerNerve !== null ? formatMoneyCompact(summary.valuePerNerve) : "—"}</dd>
        </div>
        <div class="md:pl-5">
          <dt class="text-[11px] font-medium text-fg-faint">Jail time</dt>
          <dd class="tnum mt-1 text-[20px] font-semibold {summary.jailedCount > 0 ? 'text-negative' : 'text-fg'}">{summary.jailedCount > 0 ? `${summary.jailedCount}× · ${Math.round(summary.totalJailSeconds / 3600)}h` : "0×"}</dd>
        </div>
      </dl>
    </section>

    <p class="text-xs text-fg-faint">
      Cash figures are <span class="font-medium text-fg">exact</span> from your Torn logs; item reward values are
      <span class="font-medium text-warning">estimates</span> from the Torn item catalog and are never mixed into the exact cash total.
    </p>

    {#if summary && summary.skillProgression.length > 0}
      <section>
        <h2 class="section-label text-[12px]">Crime skill progression — from Torn's own skill bookkeeping</h2>
        <div class="overflow-hidden rounded-card border border-border bg-surface shadow-panel">
          <table class="w-full text-left text-[13px]">
            <thead class="border-b border-border text-[11px] uppercase tracking-wide text-fg-faint">
              <tr>
                <th class="px-4 py-2.5 font-medium">Crime</th>
                <th class="px-4 py-2.5 text-right font-medium">Skill level</th>
                <th class="px-4 py-2.5 text-right font-medium">Change</th>
                <th class="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Level ups / downs</th>
                <th class="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Last change</th>
              </tr>
            </thead>
            <tbody>
              {#each summary.skillProgression as sk (sk.crime)}
                <tr class="border-b border-border/60 last:border-0">
                  <td class="px-4 py-2.5 capitalize text-fg">{sk.crime}</td>
                  <td class="tnum px-4 py-2.5 text-right font-medium text-fg">
                    {#if sk.level !== null}
                      {sk.level}
                    {:else if sk.snapshotLevel !== null}
                      <span title="Exact level from Torn's personalstats snapshot — this crime has no skill-change log in your stored history">{sk.snapshotLevel}<span class="ml-1 text-[10px] font-normal text-fg-faint">snapshot</span></span>
                    {:else}
                      —
                    {/if}
                  </td>
                  <td class="tnum px-4 py-2.5 text-right {sk.delta !== null ? (sk.delta > 0 ? 'text-positive' : sk.delta < 0 ? 'text-warning' : 'text-fg-faint') : 'text-fg-faint'}"
                    title={sk.delta !== null && sk.delta < 0 ? "Net level decrease — includes observed skill-down events (exact observations, never hidden)" : "Net level change over observed skill events"}>
                    {sk.delta !== null ? (sk.delta > 0 ? "+" : "") + String(sk.delta) : "—"}
                  </td>
                  <td class="tnum hidden px-4 py-2.5 text-right text-fg-muted sm:table-cell">{sk.levelUps} / {sk.levelDowns}</td>
                  <td class="tnum hidden px-4 py-2.5 text-right text-fg-faint sm:table-cell">{sk.lastChangeAt !== null ? td.displayDate(sk.lastChangeAt) : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="border-t border-border/60 px-4 py-2.5 text-[11px] leading-relaxed text-fg-faint">
            Skill levels are Torn's own per-crime values (exact). Log-observed levels come from the skill bookkeeping and are observed at skill-change moments; rows marked <span class="font-medium">snapshot</span> show the exact level from the latest personalstats snapshot for crimes with no skill-change log in your stored history.
          </p>
        </div>
      </section>
    {/if}

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
      <p class="rounded-tile border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
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
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Crime</th>
                <th class="text-right">Att.</th>
                <th class="text-right">Rate</th>
                <th class="text-right">Cash in</th>
                <th class="text-right">Cash out</th>
                <th class="text-right">Items (est.)</th>
                <th class="text-right">Nerve</th>
                <th class="text-right">Per nerve</th>
              </tr>
            </thead>
            <tbody>
              {#each summary.byCrime.slice(0, 12) as row, i (row.crime)}
                <tr class="border-b border-border/50 last:border-0 transition-colors hover:bg-surface-2/50 {i % 2 === 1 ? 'bg-surface-2/30' : ''}">
                  <td class="max-w-[240px] truncate font-medium text-fg" title={row.crime}>{row.crime}</td>
                  <td class="tnum text-right font-semibold text-fg">{row.attempts}</td>
                  <td class="tnum text-right {row.successRate !== null && row.successRate >= 0.5 ? 'text-positive' : 'text-fg-muted'}">{row.successRate !== null ? `${Math.round(row.successRate * 100)}%` : "—"}</td>
                  <td class="tnum text-right text-positive">{row.cashGained > 0 ? formatMoneyCompact(row.cashGained) : "—"}</td>
                  <td class="tnum text-right text-negative">{row.cashLost > 0 ? formatMoneyCompact(row.cashLost) : "—"}</td>
                  <td class="tnum text-right text-warning">{row.estimatedItemsValue !== null ? formatMoneyCompact(row.estimatedItemsValue) : "—"}</td>
                  <td class="tnum text-right text-fg-muted">{row.nerveUsed ?? "—"}</td>
                  <td class="tnum text-right text-warning">{row.valuePerNerve !== null ? formatMoneyCompact(row.valuePerNerve) : "—"}</td>
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
          <table class="tsv-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Crime</th>
                <th>Outcome</th>
                <th class="text-right">Nerve</th>
                <th class="text-right">Cash</th>
                <th class="text-right">Other rewards</th>
                <th class="text-right">Est. items</th>
              </tr>
            </thead>
            <tbody>
              {#each timeline.items as ev (ev.id)}
                <tr>
                  <td class="tnum whitespace-nowrap text-xs text-fg-faint">{td.displayDateTime(ev.occurredAt)}</td>
                  <td class="max-w-[260px] truncate text-fg" title={ev.crimeName ?? ""}>{ev.crimeName ?? "Unknown crime"}</td>
                  <td class="">
                    <span class={`chip ${ev.success ? "chip-positive" : "chip-negative"}`}>
                      {ev.success ? "Success" : "Failed"}
                    </span>
                  </td>
                  <td class="tnum text-right text-fg-muted">{ev.nerveUsed ?? "—"}</td>
                  <td class="tnum text-right {ev.moneyDelta !== null ? (ev.moneyDelta >= 0 ? 'text-positive' : 'text-negative') : 'text-fg-faint'}">
                    {ev.moneyDelta !== null ? formatSignedMoney(ev.moneyDelta) : "—"}
                  </td>
                  <td class="max-w-[240px] truncate text-right text-xs text-fg-muted" title={ev.otherRewards.length > 0 ? otherRewardLine(ev.otherRewards) : ""}>
                    {#if ev.otherRewards.length > 0}
                      {otherRewardLine(ev.otherRewards)}
                    {:else}
                      <span class="text-fg-faint">—</span>
                    {/if}
                  </td>
                  <td class="tnum text-right text-fg-muted">{ev.itemsValue !== null ? formatMoneyCompact(ev.itemsValue) : "—"}</td>
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
