<script lang="ts">
  import type { ProgressionResponse } from "@tornscope/shared";
  import {
    formatKpiValue,
    periodLabel,
    formatMoneyCompact,
    formatSignedMoneyCompact,
    formatDateTime,
    formatDate,
  } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { confidenceTitle } from "$lib/confidence";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, valueAxis, dayLabel, MOTION } from "$lib/charts";

  let progression = $state<ProgressionResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  async function load() {
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      progression = await endpoints.progression(range);
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

  // Permission-aware sections: unavailable data must never render as zeros.
  const statAv = $derived(progression?.availability?.battlestats);
  const statBlocked = $derived(statAv !== undefined && !availabilityHasData(statAv));
  const energyAv = $derived(progression?.availability?.energy);
  const energyBlocked = $derived(energyAv !== undefined && !availabilityHasData(energyAv));

  /* --------------------------- battlestat chart --------------------------- */
  type StatKey = "strength" | "defense" | "speed" | "dexterity";
  const STAT_META: Array<{ key: StatKey; label: string; color: string }> = [
    { key: "strength", label: "Strength", color: "#f87171" },
    { key: "defense", label: "Defense", color: "#60a5fa" },
    { key: "speed", label: "Speed", color: "#4ade80" },
    { key: "dexterity", label: "Dexterity", color: "#c084fc" },
  ];
  let visibleStats = $state<Set<StatKey>>(new Set(STAT_META.map((s) => s.key)));
  let chartMode = $state<"absolute" | "growth">("absolute");

  function toggleStat(key: StatKey) {
    const next = new Set(visibleStats);
    if (next.has(key)) {
      if (next.size > 1) next.delete(key); // keep at least one line visible
    } else next.add(key);
    visibleStats = next;
  }

  const MAX_POINTS = 500;
  function downsample<T>(rows: T[]): T[] {
    if (rows.length <= MAX_POINTS) return rows;
    const step = Math.ceil(rows.length / MAX_POINTS);
    return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  }

  const chartData = $derived.by(() => {
    const series = progression?.battlestats.series ?? [];
    if (series.length < 2) return null;
    const shown = downsample(series);
    const open = shown[0]!;
    const growth = chartMode === "growth";
    return {
      labels: shown.map((p) => dayLabel(p.t)),
      series: STAT_META.filter((s) => visibleStats.has(s.key)).map((s) => ({
        name: s.label,
        type: "line" as const,
        data: shown.map((p) => {
          const raw = p[s.key];
          if (raw === null) return null;
          const base = growth ? (open[s.key] ?? raw) : 0;
          return growth ? raw - base : raw;
        }),
        showSymbol: false,
        lineStyle: { color: s.color, width: 2 },
        itemStyle: { color: s.color },
      })),
      growth,
    };
  });

  const statChartOption = $derived.by(() => {
    if (!chartData) return null;
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: chartData.series.map((s) => s.name), top: 0, right: 0 },
      grid: GRID,
      xAxis: timeAxis(chartData.labels),
      yAxis: valueAxis(),
      series: chartData.series,
    };
  });

  /* ------------------------------ formatting ------------------------------ */
  const ratioSentence = $derived.by(() => {
    const t = progression?.training;
    if (!t || t.efficiencyVsBaseline === null || t.baselineMedianGainPerEnergy === null) return null;
    const pct = Math.round((t.efficiencyVsBaseline - 1) * 100);
    const dir = pct >= 0 ? "above" : "below";
    return `${Math.abs(pct)}% ${dir} your tracked baseline (${t.baselineSamples} earlier session${t.baselineSamples === 1 ? "" : "s"})`;
  });

  const energyQualityChip = $derived.by(() => {
    const q = progression?.energy.reconciliation.quality ?? "unavailable";
    if (q === "full") return { label: "Reconciled from bar history", cls: "chip-positive" };
    if (q === "partial") return { label: "Partial bar history", cls: "chip-warning" };
    return { label: "No bar history", cls: "chip-quiet" };
  });

  const milestones = $derived(progression?.battlestats.milestones ?? []);
  const levelChanges = $derived((progression?.profile.levelHistory ?? []).filter((row, i, all) => i === 0 || all[i - 1]!.level !== row.level));

  const capTimeSentence = $derived.by(() => {
    const e = progression?.energy;
    if (!e || e.cappedSeconds === null || e.cappedSeconds < 300) return null;
    const hours = Math.floor(e.cappedSeconds / 3600);
    const minutes = Math.round((e.cappedSeconds % 3600) / 60);
    return `Observed at the energy cap for at least ${hours > 0 ? `${hours}h ` : ""}${minutes}m — regeneration while full is potential, not banked`;
  });
</script>

<svelte:head><title>Progression · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Training"
    title="Progression"
    description="Battlestat growth from hourly stat snapshots, energy flow from five-minute bar history, and training sessions inferred from both — every figure labeled exact, derived, estimated or inferred."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !progression}
    <StateMessage state="loading" />
  {:else if error && !progression}
    <StateMessage state="error" title="Could not load progression analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if progression}
    <!-- ═══ Editorial masthead ═══ -->
    <section aria-labelledby="prog-masthead" class="rounded-card border border-border bg-surface px-5 py-5 shadow-panel sm:px-7">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="prog-masthead" class="section-label !tracking-[0.12em]">{period} in training</h2>
        <div class="flex flex-wrap items-center gap-2">
          <span class="chip chip-quiet !border-border !text-[10px]" title="Battlestat values recorded by Torn, hourly">exact</span>
          <span class="chip chip-quiet !border-border !text-[10px]" title="Computed deterministically from exact observations">derived</span>
          <span class="chip chip-quiet !border-border !text-[10px]" title="Pattern-based conclusion — evidence always shown">inferred</span>
        </div>
      </div>
      <p class="mt-3 max-w-4xl font-display text-lg leading-relaxed text-fg sm:text-xl">
        {#if progression.summary.totalDelta.value !== null}
          Your battlestats grew by
          <span class="tnum font-semibold {progression.summary.totalDelta.value >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedMoneyCompact(progression.summary.totalDelta.value)}</span>
          across {period.toLowerCase()}
          {#if progression.summary.gainPerDay.value !== null}— about {formatMoneyCompact(progression.summary.gainPerDay.value)} per day{/if}.
        {:else if progression.battlestats.trackedSince !== null}
          Battlestat history is still accumulating — nothing in this range yet.
        {:else}
          Battlestat history starts with your first personal-stats sync.
        {/if}
      </p>
      <p class="mt-2 max-w-4xl text-sm leading-relaxed text-fg-muted">
        {#if progression.energy.covered}
          {formatMoneyCompact(progression.summary.energyTrained.value ?? 0)} of energy went into {progression.summary.sessions} inferred training session{progression.summary.sessions === 1 ? "" : "s"}
          {#if progression.summary.likelyJumps > 0}, including {progression.summary.likelyJumps} likely happy jump{progression.summary.likelyJumps === 1 ? "" : "s"}{/if}.
        {:else}
          Energy analytics begin with the first bar snapshot — Torn only exposes bars live, so TornScope records them from now on.
        {/if}
      </p>
    </section>

    <!-- ═══ A · Energy flow ═══ -->
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">A</span> Energy flow — where it came from, where it went</h2>
      {#if energyBlocked && energyAv}
        <StateMessage
          state={availabilityMessage(energyAv).state}
          title={availabilityMessage(energyAv).title}
          hint={availabilityMessage(energyAv).hint}
          action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
        />
      {:else if !progression.energy.covered}
        <StateMessage
          state="empty"
          title="No bar history in this range"
          hint="TornScope snapshots energy and happy every five minutes from the bars resource. Before that snapshot history begins, energy cannot be reconstructed honestly — it stays unavailable rather than estimated."
        />
      {:else}
        <div class="grid gap-5 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch">
          <Panel title="Energy in" caption="Gains recorded by Torn logs plus regeneration derived from bar deltas">
            <ul class="space-y-2.5 text-[13px]">
              {#each progression.energy.sources as source (source.category)}
                <li class="flex items-baseline justify-between gap-3">
                  <span class="flex items-center gap-2 text-fg">
                    {source.category}
                    <ProvenanceBadge level={source.provenance} />
                  </span>
                  <span class="tnum font-medium text-positive">+{formatMoneyCompact(source.amount)}</span>
                </li>
              {/each}
              {#if progression.energy.sources.length === 0}
                <li class="text-fg-faint">No energy gains recorded in this range.</li>
              {/if}
            </ul>
            {#if progression.energy.potentialRegen !== null}
              <p class="mt-4 text-[11px] leading-relaxed text-fg-faint">
                Potential natural regeneration while full: ~{formatMoneyCompact(progression.energy.potentialRegen)} (estimated from your observed regen rate of {progression.energy.regenPerHour !== null ? progression.energy.regenPerHour.toFixed(1) : "—"} per hour — never counted as banked energy).
              </p>
            {/if}
          </Panel>

          <div class="hidden items-center justify-center lg:flex" aria-hidden="true">
            <span class="text-2xl text-border-strong">→</span>
          </div>

          <Panel title="Energy out" caption="Observed declines attributed by evidence — unattributed stays unattributed">
            <ul class="space-y-2.5 text-[13px]">
              {#each progression.energy.uses as use (use.category)}
                <li class="flex items-baseline justify-between gap-3">
                  <span class="flex items-center gap-2 text-fg">
                    {use.category}
                    <ProvenanceBadge level={use.provenance} />
                  </span>
                  <span class="tnum font-medium text-negative">-{formatMoneyCompact(use.amount)}</span>
                </li>
              {/each}
              {#if progression.energy.uses.length === 0}
                <li class="text-fg-faint">No energy declines observed in this range.</li>
              {/if}
            </ul>
            <p class="mt-4 text-[11px] leading-relaxed text-fg-faint">
              Attacks carry no energy cost in Torn's data, so their spend stays unattributed — drops during attacks are never called training.
            </p>
          </Panel>
        </div>

        <Panel title="Energy reconciliation" caption="Opening plus known gains plus derived regeneration, against what the bars actually show">
          <div class="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-border bg-border md:grid-cols-5">
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Opening energy</p><p class="tnum mt-1 text-lg font-semibold text-fg">{progression.energy.reconciliation.opening !== null ? progression.energy.reconciliation.opening : "—"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Known gains</p><p class="tnum mt-1 text-lg font-semibold text-positive">{progression.energy.sources.filter((s) => s.category !== "Natural regen (derived)").reduce((sum, s) => sum + s.amount, 0) !== 0 ? `+${formatMoneyCompact(progression.energy.sources.filter((s) => s.category !== "Natural regen (derived)").reduce((sum, s) => sum + s.amount, 0))}` : "0"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Derived regen</p><p class="tnum mt-1 text-lg font-semibold text-positive">{progression.energy.derivedRegen !== null ? `+${formatMoneyCompact(progression.energy.derivedRegen)}` : "—"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Observed declines</p><p class="tnum mt-1 text-lg font-semibold text-negative">{progression.energy.uses.reduce((sum, u) => sum + u.amount, 0) !== 0 ? `-${formatMoneyCompact(progression.energy.uses.reduce((sum, u) => sum + u.amount, 0))}` : "0"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Closing energy</p><p class="tnum mt-1 text-lg font-semibold text-fg">{progression.energy.reconciliation.closing !== null ? progression.energy.reconciliation.closing : "—"}</p></div>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
            <span class="{energyQualityChip.cls} chip !px-1.5 !text-[9px] !uppercase">{energyQualityChip.label}</span>
            {#if capTimeSentence}<span>{capTimeSentence}.</span>{/if}
            {#if progression.energy.absorbedOvershoot !== null}
              <span title="Known gains (mostly the Xanax estimate) that never materialized as observed energy — usually a cap interaction">{formatMoneyCompact(progression.energy.absorbedOvershoot)} of known gains never showed up in the bars (cap interaction) — surfaced, not silently dropped.</span>
            {/if}
          </div>
        </Panel>
      {/if}
    </section>

    <!-- ═══ B · Battlestat progression ═══ -->
    <section class="space-y-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">B</span> Battlestat progression — hourly observations from Torn personal stats</h2>
        {#if progression.battlestats.trackedSince !== null}
          <span class="text-[11px] text-fg-faint">Tracked since {formatDate(progression.battlestats.trackedSince)}</span>
        {/if}
      </div>
      {#if statBlocked && statAv}
        <StateMessage
          state={availabilityMessage(statAv).state}
          title={availabilityMessage(statAv).title}
          hint={availabilityMessage(statAv).hint}
          action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
        />
      {:else}
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
          <Stat label="Total battlestats" value={formatKpiValue(progression.summary.totalBattlestats, formatMoneyCompact)} provenance="exact" tone="accent" confidence={progression.battlestats.confidence} confidenceTooltip={confidenceTitle(progression.battlestats.confidence)} />
          <Stat label="{period} change" value={progression.summary.totalDelta.value !== null ? formatSignedMoneyCompact(progression.summary.totalDelta.value) : "—"} provenance="derived" confidence={progression.battlestats.confidence} tone={progression.summary.totalDelta.value === null ? "neutral" : progression.summary.totalDelta.value >= 0 ? "positive" : "negative"} sub={progression.battlestats.changePct !== null ? `${progression.battlestats.changePct >= 0 ? "+" : ""}${progression.battlestats.changePct.toFixed(2)}%` : null} />
          <Stat label="Gain per day" value={formatKpiValue(progression.summary.gainPerDay, formatMoneyCompact)} provenance="derived" confidence={progression.battlestats.confidence} />
          <Stat label="Awards {period}" value={progression.profile.awardsDelta !== null ? formatSignedMoneyCompact(progression.profile.awardsDelta) : "—"} provenance="derived" confidence={progression.battlestats.confidence} sub={progression.profile.awards !== null ? `${progression.profile.awards} total` : null} />
        </div>

        <Panel title="Stat history" caption="Every point is a real Torn observation — nothing is interpolated">
          {#snippet actions()}
            <div class="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-1" role="group" aria-label="Chart mode">
              <button
                class="rounded-full px-2.5 py-1 text-[11px] font-medium transition-all {chartMode === 'absolute' ? 'bg-fg font-semibold text-bg' : 'text-fg-muted hover:text-fg'}"
                onclick={() => (chartMode = "absolute")}
                aria-pressed={chartMode === "absolute"}
              >Absolute</button>
              <button
                class="rounded-full px-2.5 py-1 text-[11px] font-medium transition-all {chartMode === 'growth' ? 'bg-fg font-semibold text-bg' : 'text-fg-muted hover:text-fg'}"
                onclick={() => (chartMode = "growth")}
                aria-pressed={chartMode === "growth"}
              >Growth</button>
            </div>
          {/snippet}
          {#if !statChartOption}
            <StateMessage state="empty" compact title="Not enough observations in this range" hint="Stat snapshots collect hourly — widen the range or wait for the next syncs." />
          {:else}
            <div class="mb-3 flex flex-wrap gap-1.5">
              {#each STAT_META as stat (stat.key)}
                <button
                  class="chip cursor-pointer transition-opacity {!visibleStats.has(stat.key) ? 'opacity-40' : ''}"
                  style="border-color: {stat.color}55"
                  onclick={() => toggleStat(stat.key)}
                  aria-pressed={visibleStats.has(stat.key)}
                  title="Toggle {stat.label} line"
                >
                  <span class="inline-block h-2 w-2 rounded-full align-middle" style="background: {stat.color}"></span>
                  {stat.label}
                </button>
              {/each}
            </div>
            <Chart option={statChartOption} height={320} />
            {#if chartData?.growth}
              <p class="mt-2 text-[11px] text-fg-faint">Growth mode: each stat starts at 0 at the start of the selected period — fair visual comparison of observed gains.</p>
            {/if}
          {/if}
        </Panel>

        <div class="grid gap-5 lg:grid-cols-2">
          <Panel title="Stat distribution & change" caption="Share of total battlestats — builds differ; there is no ideal balance">
            <div class="overflow-x-auto">
              <table class="tsv-table">
                <thead>
                  <tr>
                    <th>Stat</th>
                    <th class="text-right">Current</th>
                    <th class="text-right">Share</th>
                    <th class="text-right">{period} change</th>
                  </tr>
                </thead>
                <tbody>
                  {#each progression.battlestats.perStat as stat (stat.key)}
                    {@const share = progression.battlestats.distribution.find((d) => d.key === stat.key)?.share ?? null}
                    <tr>
                      <td class="text-fg">{stat.label}</td>
                      <td class="tnum text-right text-fg-muted">{stat.closing !== null ? formatMoneyCompact(stat.closing) : "—"}</td>
                      <td class="tnum text-right text-fg-faint">{share !== null ? `${Math.round(share * 100)}%` : "—"}</td>
                      <td class="tnum text-right font-medium {stat.delta === null ? 'text-fg-faint' : stat.delta >= 0 ? 'text-positive' : 'text-negative'}">{stat.delta !== null ? formatSignedMoneyCompact(stat.delta) : "—"}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Milestones" caption="Deterministic threshold crossings — the window is shown when the exact moment is not known">
            {#if milestones.length === 0 && levelChanges.length === 0}
              <StateMessage state="empty" compact title="No milestone crossings in this range" />
            {:else}
              <ul class="space-y-2.5 text-[13px]">
                {#each milestones.slice(0, 8) as m (m.kind + m.threshold + m.crossedBetween[0])}
                  <li class="flex items-baseline justify-between gap-3">
                    <span class="text-fg">{m.label} crossed {formatMoneyCompact(m.threshold)}</span>
                    <span class="tnum text-[11px] text-fg-faint" title="Crossed between these two observations">{formatDate(m.crossedBetween[0])} → {formatDate(m.crossedBetween[1])}</span>
                  </li>
                {/each}
                {#each levelChanges as lv (lv.t)}
                  <li class="flex items-baseline justify-between gap-3">
                    <span class="text-fg">Level {lv.level}</span>
                    <span class="tnum text-[11px] text-fg-faint">{formatDate(lv.t)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </Panel>
        </div>
      {/if}
    </section>

    <!-- ═══ C · Training ═══ -->
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">C</span> Training — sessions inferred from energy declines and stat gains</h2>
      {#if progression.training.sessions.length === 0}
        <StateMessage state="empty" title="No training sessions inferred in this range" hint="Sessions need bar history (energy declines) and hourly stat snapshots. Both accumulate automatically." />
      {:else}
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
          <Stat label="Gain per energy (median)" value={progression.training.medianGainPerEnergy !== null ? progression.training.medianGainPerEnergy.toFixed(1) : "—"} provenance="estimated" confidence={progression.training.confidence} title="Observed battlestat gain divided by attributed training energy — an estimate, not an exact gym figure" />
          <Stat label="Training days" value={String(progression.training.daysTrained)} provenance="estimated" confidence={progression.training.confidence} sub={`${progression.summary.sessions} session${progression.summary.sessions === 1 ? "" : "s"}`} />
          <Stat label="Energy trained" value={formatKpiValue(progression.summary.energyTrained, formatMoneyCompact)} provenance="estimated" confidence={progression.training.confidence} sub={progression.training.avgEnergyPerTrainingDay !== null ? `${formatMoneyCompact(progression.training.avgEnergyPerTrainingDay)} per training day` : null} />
          <Stat label="Happy jumps" value={String(progression.happyJumps.jumps.length)} provenance="estimated" confidence={progression.happyJumps.confidence} sub={`${progression.summary.likelyJumps} likely`} />
        </div>

        {#if ratioSentence}
          <p class="rounded-tile border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
            Current gain per energy is <span class="font-medium text-fg">{ratioSentence}</span> — a personal comparison, never a universal judgment.
          </p>
        {/if}

        {#if progression.training.normalVsJump.normalSamples >= 2 || progression.training.normalVsJump.jumpSamples >= 2}
          <Panel title="Normal training vs happy jumps" caption="Personal medians only — compared when there are enough reliable sessions">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div class="rounded-tile border border-border bg-surface-2 p-4">
                <p class="text-[11px] font-medium text-fg-faint">Normal sessions <span class="text-fg-faint/70">({progression.training.normalVsJump.normalSamples} with gain/E)</span></p>
                <p class="tnum mt-1 text-lg font-semibold text-fg">{progression.training.normalVsJump.normalMedianGainPerEnergy !== null ? `${progression.training.normalVsJump.normalMedianGainPerEnergy.toFixed(1)} / E` : "—"}</p>
              </div>
              <div class="rounded-tile border border-accent/30 bg-accent/5 p-4">
                <p class="text-[11px] font-medium text-fg-faint">Happy-jump sessions <span class="text-fg-faint/70">({progression.training.normalVsJump.jumpSamples} with gain/E)</span></p>
                <p class="tnum mt-1 text-lg font-semibold text-accent">{progression.training.normalVsJump.jumpMedianGainPerEnergy !== null ? `${progression.training.normalVsJump.jumpMedianGainPerEnergy.toFixed(1)} / E` : "—"}</p>
              </div>
            </div>
          </Panel>
        {/if}

        <Panel title="Recent training sessions" caption="Inferred bursts — energy observed from bar deltas, gains observed across the hourly stat bracket">
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>Window</th>
                  <th class="text-right">Energy</th>
                  <th class="text-right">Observed gain</th>
                  <th class="text-right">Gain / E</th>
                  <th>Stat</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {#each progression.training.sessions.slice().reverse().slice(0, 12) as session (session.startedAt)}
                  <tr>
                    <td class="tnum whitespace-nowrap text-xs text-fg-faint">{formatDateTime(session.startedAt)} → {formatDateTime(session.endedAt).slice(-5)}</td>
                    <td class="tnum text-right {session.energySpent !== null ? 'text-negative' : 'text-fg-faint'}">{session.energySpent !== null ? formatMoneyCompact(session.energySpent) : "—"}</td>
                    <td class="tnum text-right {session.totalGain !== null && session.totalGain > 0 ? 'text-positive' : 'text-fg-faint'}">{session.totalGain !== null ? `+${formatMoneyCompact(session.totalGain)}` : "—"}</td>
                    <td class="tnum text-right text-fg-muted">{session.gainPerEnergy !== null ? session.gainPerEnergy.toFixed(1) : "—"}</td>
                    <td>
                      {#if session.primaryStat === "mixed"}
                        <span class="chip chip-quiet !border-border !px-1.5 !text-[9px] !uppercase">mixed</span>
                      {:else if session.primaryStat}
                        <span class="chip chip-quiet !border-border !px-1.5 !text-[9px] !uppercase">{session.primaryStat}</span>
                      {:else}
                        <span class="text-fg-faint">—</span>
                      {/if}
                    </td>
                    <td>
                      <span class="chip {session.inference === 'likely' ? 'chip-positive' : 'chip-warning'} !px-1.5 !text-[9px] !uppercase" title={session.evidence.join(" · ")}>{session.inference}</span>
                      {#if session.bracketShared}<span class="ml-1 text-[10px] text-fg-faint">shared window</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="mt-4 text-[11px] text-fg-faint">
            Torn has no gym-training log: sessions are TornScope's inference from energy declines that no competing activity (like attacks) explains. "Observed gain" is the bracket delta, never an exact per-train figure.
          </p>
        </Panel>
      {/if}
    </section>

    <!-- ═══ D · Happy jumps ═══ -->
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">D</span> Happy jumps — inferred, with the evidence in the open</h2>
      {#if progression.happyJumps.jumps.length === 0}
        <StateMessage state="empty" title="No happy jumps inferred in this range" hint="A jump needs a large training burst plus preparation evidence (Xanax cluster, Ecstasy, refill) — Torn has no direct happy-jump record." />
      {:else}
        <div class="space-y-4">
          {#each progression.happyJumps.jumps as jump (jump.trainedFrom)}
            <details class="group rounded-card border {jump.confidence === 'likely' ? 'border-accent/40' : 'border-border'} bg-surface shadow-panel">
              <summary class="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
                <div class="min-w-0">
                  <p class="text-[13px] font-semibold text-fg">
                    {formatDate(jump.trainedFrom)}
                    <span class="ml-2 font-normal text-fg-muted">Likely Happy Jump</span>
                    <span class="ml-2 chip {jump.confidence === 'likely' ? 'chip-positive' : 'chip-warning'} !px-1.5 !text-[9px] !uppercase">{jump.confidence}</span>
                  </p>
                  <p class="mt-1 text-[11.5px] text-fg-faint">
                    Preparation
                    {jump.xanaxCount > 0 ? `${jump.xanaxCount}× Xanax` : "—"}
                    {jump.ecstasyCount > 0 ? "· Ecstasy" : ""}
                    {jump.refillUsed ? "· Refill" : ""}
                    · Training {jump.energySpent !== null ? `${formatMoneyCompact(jump.energySpent)} E` : "—"}
                    · Observed gain {jump.totalGain !== null ? `+${formatMoneyCompact(jump.totalGain)}` : "—"}{jump.primaryStat === "mixed" ? " (mixed)" : jump.primaryStat ? ` ${jump.primaryStat.toUpperCase()}` : ""}
                  </p>
                </div>
                <span class="text-fg-faint transition-transform group-open:rotate-180">▾</span>
              </summary>
              <div class="grid gap-px overflow-hidden border-t border-border bg-border sm:grid-cols-4">
                <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Energy used</p><p class="tnum mt-1 text-lg font-semibold text-negative">{jump.energySpent !== null ? formatMoneyCompact(jump.energySpent) : "—"}</p></div>
                <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Observed gain</p><p class="tnum mt-1 text-lg font-semibold text-positive">{jump.totalGain !== null ? `+${formatMoneyCompact(jump.totalGain)}` : "—"}</p></div>
                <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Gain per energy</p><p class="tnum mt-1 text-lg font-semibold text-fg">{jump.gainPerEnergy !== null ? jump.gainPerEnergy.toFixed(1) : "—"}</p></div>
                <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Peak observed happy</p><p class="tnum mt-1 text-lg font-semibold text-fg">{jump.peakHappyObserved !== null ? jump.peakHappyObserved : "—"}</p></div>
              </div>
              <div class="border-t border-border px-5 py-4">
                <p class="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-faint">Why TornScope classified this as a {jump.confidence} happy jump</p>
                <ul class="mt-2 space-y-1 text-xs leading-relaxed text-fg-muted">
                  {#each jump.evidence as line (line)}
                    <li>· {line}</li>
                  {/each}
                </ul>
                <p class="mt-3 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-faint">Missing</p>
                <ul class="mt-1 space-y-1 text-xs leading-relaxed text-fg-faint">
                  {#each jump.missing as line (line)}
                    <li>· {line}</li>
                  {/each}
                </ul>
              </div>
            </details>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
