<script lang="ts">
  import type { CombatSummaryResponse, CombatTimelineResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatDateTime, formatKpiValue, periodLabel, formatDate, combatEventSemantics } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel } from "$lib/charts";

  let summary = $state<CombatSummaryResponse | null>(null);
  let timeline = $state<CombatTimelineResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  // Permission gate: combat comes from the attacks endpoint.
  const histAv = $derived(summary?.availability?.history);
  const histBlocked = $derived(histAv !== undefined && !availabilityHasData(histAv));
  const histMsg = $derived(histAv ? availabilityMessage(histAv) : null);

  async function load() {
    loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      summary = await endpoints.combatSummary(range);
      timeline = await endpoints.combatTimeline(range);
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

  const activityOption = $derived.by(() => {
    if (!summary || summary.dailySeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: ["Outgoing (I attacked)", "Incoming (attacked me)"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(summary.dailySeries.map((p) => dayLabel(p.t))),
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: C.label, fontSize: 10.5 }, splitLine: { lineStyle: { color: C.splitLine } }, axisLine: { show: false } },
      series: [
        { name: "Outgoing (I attacked)", type: "bar", stack: "attacks", data: summary.dailySeries.map((p) => p.made), barMaxWidth: 12, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
        { name: "Incoming (attacked me)", type: "bar", stack: "attacks", data: summary.dailySeries.map((p) => p.received), barMaxWidth: 12, itemStyle: { color: C.violet ?? "#a78bfa", borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });

  /** Direction-labelled result series — wins/losses never mix directions. */
  const winLossOption = $derived.by(() => {
    if (!summary || summary.dailySeries.length === 0) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: ["Outgoing win", "Outgoing loss", "Defended incoming", "Lost incoming"], top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(summary.dailySeries.map((p) => dayLabel(p.t))),
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: C.label, fontSize: 10.5 }, splitLine: { lineStyle: { color: C.splitLine } }, axisLine: { show: false } },
      series: [
        { name: "Outgoing win", type: "bar", stack: "outgoing", data: summary.dailySeries.map((p) => p.outgoingWins), barMaxWidth: 12, itemStyle: { color: C.positive, borderRadius: [3, 3, 0, 0] } },
        { name: "Outgoing loss", type: "bar", stack: "outgoing", data: summary.dailySeries.map((p) => p.outgoingLosses), barMaxWidth: 12, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
        { name: "Defended incoming", type: "bar", stack: "incoming", data: summary.dailySeries.map((p) => p.incomingDefended), barMaxWidth: 12, itemStyle: { color: C.accentStrong, borderRadius: [3, 3, 0, 0] } },
        { name: "Lost incoming", type: "bar", stack: "incoming", data: summary.dailySeries.map((p) => p.incomingLost), barMaxWidth: 12, itemStyle: { color: C.warning, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });
</script>

<svelte:head><title>Combat · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Combat"
    title="Attacks"
    description="Every attack from your Torn combat record — exact results and respect, opponents as Torn reports them."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !summary}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load combat analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if summary}
    {#if histBlocked && histAv}
      <!-- Combat needs User Attacks: a permission state, never zeros -->
      <StateMessage
        state={histMsg!.state}
        title={histMsg!.title}
        hint={histMsg!.hint}
        action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
      />
    {:else}
    {#if summary.coverage.trackingSince !== null}
      <p class="rounded-tile border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Tracking since {formatDate(summary.coverage.trackingSince)}</span>
        — combat events come from your Torn attacks record (kept permanently once stored). Mug cash is tracked in the Economy ledger
        under the mugging category, never duplicated here.
      </p>
    {/if}

    <!-- Outgoing vs incoming: two open directional columns, never merged -->
    <section class="section-rule" aria-label="Outgoing and incoming">
      <div class="grid grid-cols-1 gap-x-10 gap-y-7 lg:grid-cols-2 lg:divide-x lg:divide-border">
        <div class="min-w-0 lg:pr-10">
          <p class="section-label">Outgoing — attacks I initiated</p>
          <dl class="mt-3 grid grid-cols-4 gap-x-2 gap-y-4">
            <div>
              <dt class="order-2 text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">attacks</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-fg">{summary.attacksMade}</dd>
            </div>
            <div>
              <dt class="text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">wins</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-positive">{summary.outgoingWins}</dd>
            </div>
            <div>
              <dt class="text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">losses</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-negative">{summary.outgoingLosses}</dd>
            </div>
            <div>
              <dt class="text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">mugs</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-fg">{summary.mugsMade}</dd>
            </div>
          </dl>
        </div>
        <div class="min-w-0 lg:pl-10">
          <p class="section-label">Incoming — attacks against me</p>
          <dl class="mt-3 grid grid-cols-4 gap-x-2 gap-y-4">
            <div>
              <dt class="text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">attacks</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-fg">{summary.attacksReceived}</dd>
            </div>
            <div>
              <dt class="text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">defended</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-positive">{summary.incomingDefended}</dd>
            </div>
            <div>
              <dt class="text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">lost</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-negative">{summary.incomingLost}</dd>
            </div>
            <div>
              <dt class="text-[10.5px] font-medium uppercase tracking-[0.13em] text-fg-faint">mugged</dt>
              <dd class="tnum text-[26px] font-semibold leading-none text-fg">{summary.mugsReceived}</dd>
            </div>
          </dl>
        </div>
      </div>

      <dl class="mt-8 grid grid-cols-2 gap-y-5 border-t border-border pt-5 md:grid-cols-4 md:divide-x md:divide-border">
        <div class="md:pr-5">
          <dt class="text-[11px] font-medium text-fg-faint">{period} attacks made</dt>
          <dd class="tnum mt-1 text-[20px] font-semibold text-accent">{summary.attacksMade}</dd>
          <dd class="text-[11px] text-fg-faint">{summary.attacksReceived} received</dd>
        </div>
        <div class="md:px-5">
          <dt class="text-[11px] font-medium text-fg-faint">{period} wins (both directions)</dt>
          <dd class="tnum mt-1 text-[20px] font-semibold text-positive">{summary.wins}</dd>
          <dd class="text-[11px] text-fg-faint">{summary.winRate !== null ? `${Math.round(summary.winRate * 100)}% of decided` : ""}</dd>
        </div>
        <div class="md:px-5">
          <dt class="text-[11px] font-medium text-fg-faint">{period} hospitalizations</dt>
          <dd class="tnum mt-1 text-[20px] font-semibold text-fg">{summary.hospitalizationsCaused}</dd>
          <dd class="text-[11px] text-fg-faint">{summary.hospitalizationsReceived} received</dd>
        </div>
        <div class="md:pl-5">
          <dt class="text-[11px] font-medium text-fg-faint">Money mugged</dt>
          <dd class="tnum mt-1 text-[20px] font-semibold text-fg">{formatKpiValue(summary.moneyMugged)}</dd>
          <dd class="text-[11px] text-fg-faint">{summary.moneyLostToMugs.value !== null ? `${formatMoneyCompact(summary.moneyLostToMugs.value)} lost to mugs` : ""}</dd>
        </div>
      </dl>
    </section>

    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Attack activity" caption="Made vs received per day" flush>
        {#if !activityOption}
          <StateMessage state="empty" title="No combat activity in this range" />
        {:else}
          <Chart option={activityOption} height={280} />
        {/if}
      </Panel>
      <Panel title="Results by day" caption="Outgoing wins/losses vs defended/lost incoming — grouped, never mixed" flush>
        {#if !winLossOption}
          <StateMessage state="empty" title="No decided attacks in this range" />
        {:else}
          <Chart option={winLossOption} height={280} />
        {/if}
      </Panel>
    </section>

    {#if summary.respectGained !== null || summary.respectLost !== null}
      <p class="rounded-tile border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Respect ({period}):</span>
        {summary.respectGained !== null ? `+${summary.respectGained} gained` : "gained —"} · {summary.respectLost !== null ? `${summary.respectLost} lost` : "lost —"} — exact, from Torn's attack records.
      </p>
    {/if}

    <Panel title="Opponents" caption="Most-encountered first — unknown attackers shown honestly" flush>
      {#if summary.byOpponent.length === 0}
        <StateMessage state="empty" title="No opponents in this range" />
      {:else}
        <div class="overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th class="font-medium">Opponent</th>
                <th class="text-right font-medium">Attacks</th>
                <th class="text-right font-medium">Wins</th>
                <th class="text-right font-medium">Losses</th>
                <th class="text-right font-medium">Win rate</th>
                <th class="text-right font-medium">Last encounter</th>
              </tr>
            </thead>
            <tbody>
              {#each summary.byOpponent.slice(0, 12) as row (row.opponentId ?? row.opponent)}
                <tr>
                  <td class="max-w-[220px] truncate text-fg">{row.opponent}</td>
                  <td class="tnum text-right text-fg-muted">{row.attacks}</td>
                  <td class="tnum text-right text-positive">{row.wins}</td>
                  <td class="tnum text-right text-negative">{row.losses}</td>
                  <td class="tnum text-right text-fg-muted">{row.winRate !== null ? `${Math.round(row.winRate * 100)}%` : "—"}</td>
                  <td class="tnum text-right text-xs text-fg-faint">{formatDateTime(row.lastEncounter)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Panel>

    <Panel title="Combat feed" caption="Verbs follow YOUR perspective — Attacked (you acted), Defended (you were attacked); color shows the outcome" flush>
      {#if !timeline || timeline.items.length === 0}
        <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="No combat events in this range" /></div>
      {:else}
        <div class="overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th class="font-medium">When</th>
                <th class="font-medium">Event</th>
                <th class="font-medium">Verb</th>
                <th class="font-medium">Result</th>
                <th class="text-right font-medium">Respect</th>
              </tr>
            </thead>
            <tbody>
              {#each timeline.items as ev (ev.id)}
                {@const sem = combatEventSemantics(ev.direction, ev.result)}
                <tr>
                  <td class="tnum whitespace-nowrap text-xs text-fg-faint">{formatDateTime(ev.occurredAt)}</td>
                  <td class="text-fg">
                    {ev.direction === "outgoing" ? "vs" : "by"}
                    <span class="font-medium">{ev.opponentName ?? "Unknown opponent"}</span>
                  </td>
                  <td class="">
                    <span class={`chip ${sem.outcome === "won" ? "chip-positive" : sem.outcome === "lost" ? "chip-negative" : ""}`}>
                      {sem.verb}
                    </span>
                  </td>
                  <td class="text-fg-muted">{sem.context ?? "—"}</td>
                  <td class="tnum text-right text-fg-muted">{ev.respectDelta !== null ? (ev.respectDelta >= 0 ? "+" : "") + ev.respectDelta.toFixed(2) : "—"}</td>
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
