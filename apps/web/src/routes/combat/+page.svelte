<script lang="ts">
  import type { CombatSummaryResponse, CombatTimelineResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatDateTime, formatKpiValue, periodLabel, formatDate, combatEventSemantics } from "@tornscope/shared";
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

<div class="space-y-10">
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
      <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Tracking since {formatDate(summary.coverage.trackingSince)}</span>
        — combat events come from your Torn attacks record (kept permanently once stored). Mug cash is tracked in the Economy ledger
        under the mugging category, never duplicated here.
      </p>
    {/if}

    <!-- Outgoing vs incoming: the two sides are never merged -->
    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Outgoing — attacks I initiated" caption="My results as the attacker" flush>
        <div class="grid grid-cols-4 gap-px bg-border">
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-fg">{summary.attacksMade}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">attacks</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-positive">{summary.outgoingWins}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">wins</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-negative">{summary.outgoingLosses}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">losses</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-fg">{summary.mugsMade}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">mugs</p>
          </div>
        </div>
      </Panel>
      <Panel title="Incoming — attacks against me" caption="My results as the defender" flush>
        <div class="grid grid-cols-4 gap-px bg-border">
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-fg">{summary.attacksReceived}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">attacks</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-positive">{summary.incomingDefended}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">defended</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-negative">{summary.incomingLost}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">lost</p>
          </div>
          <div class="bg-surface p-5 text-center">
            <p class="tnum text-2xl font-semibold text-fg">{summary.mugsReceived}</p>
            <p class="mt-1 text-[10px] uppercase tracking-[0.14em] text-fg-faint">mugged</p>
          </div>
        </div>
      </Panel>
    </section>

    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
      <Stat label="{period} attacks made" value={String(summary.attacksMade)} provenance="exact" tone="accent" sub={`${summary.attacksReceived} received`} />
      <Stat label="{period} wins (both directions)" value={String(summary.wins)} provenance="exact" tone="positive" sub={summary.winRate !== null ? `${Math.round(summary.winRate * 100)}% of decided` : null} />
      <Stat label="{period} hospitalizations" value={String(summary.hospitalizationsCaused)} provenance="exact" sub={`${summary.hospitalizationsReceived} received`} />
      <Stat
        label="Money mugged"
        value={formatKpiValue(summary.moneyMugged)}
        provenance="exact"
        sub={summary.moneyLostToMugs.value !== null ? `${formatMoneyCompact(summary.moneyLostToMugs.value)} lost to mugs` : null}
      />
    </div>

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
      <p class="rounded-xl border border-border bg-surface px-5 py-3 text-xs text-fg-muted">
        <span class="font-medium text-fg">Respect ({period}):</span>
        +{summary.respectGained ?? 0} gained · {summary.respectLost ?? 0} lost — exact, from Torn's attack records.
      </p>
    {/if}

    <Panel title="Opponents" caption="Most-encountered first — unknown attackers shown honestly" flush>
      {#if summary.byOpponent.length === 0}
        <StateMessage state="empty" title="No opponents in this range" />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2.5 pl-6 pr-4 font-medium">Opponent</th>
                <th class="py-2.5 pr-4 text-right font-medium">Attacks</th>
                <th class="py-2.5 pr-4 text-right font-medium">Wins</th>
                <th class="py-2.5 pr-4 text-right font-medium">Losses</th>
                <th class="py-2.5 pr-4 text-right font-medium">Win rate</th>
                <th class="py-2.5 pr-6 text-right font-medium">Last encounter</th>
              </tr>
            </thead>
            <tbody>
              {#each summary.byOpponent.slice(0, 12) as row (row.opponentId ?? row.opponent)}
                <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                  <td class="max-w-[220px] truncate py-2.5 pl-6 pr-4 text-fg">{row.opponent}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{row.attacks}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-positive">{row.wins}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-negative">{row.losses}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{row.winRate !== null ? `${Math.round(row.winRate * 100)}%` : "—"}</td>
                  <td class="tnum py-2.5 pr-6 text-right text-xs text-fg-faint">{formatDateTime(row.lastEncounter)}</td>
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
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2.5 pl-6 pr-4 font-medium">When</th>
                <th class="py-2.5 pr-4 font-medium">Event</th>
                <th class="py-2.5 pr-4 font-medium">Verb</th>
                <th class="py-2.5 pr-4 font-medium">Result</th>
                <th class="py-2.5 pr-6 text-right font-medium">Respect</th>
              </tr>
            </thead>
            <tbody>
              {#each timeline.items as ev (ev.id)}
                {@const sem = combatEventSemantics(ev.direction, ev.result)}
                <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                  <td class="tnum whitespace-nowrap py-2.5 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(ev.occurredAt)}</td>
                  <td class="py-2.5 pr-4 text-fg">
                    {ev.direction === "outgoing" ? "vs" : "by"}
                    <span class="font-medium">{ev.opponentName ?? "Unknown opponent"}</span>
                  </td>
                  <td class="py-2.5 pr-4">
                    <span class={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${sem.outcome === "won" ? "border-positive/30 bg-positive/10 text-positive" : sem.outcome === "lost" ? "border-negative/30 bg-negative/10 text-negative" : "border-border bg-surface-2 text-fg-muted"}`}>
                      {sem.verb}
                    </span>
                  </td>
                  <td class="py-2.5 pr-4 text-fg-muted">{sem.context ?? "—"}</td>
                  <td class="tnum py-2.5 pr-6 text-right text-fg-muted">{ev.respectDelta !== null ? (ev.respectDelta >= 0 ? "+" : "") + ev.respectDelta.toFixed(2) : "—"}</td>
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
