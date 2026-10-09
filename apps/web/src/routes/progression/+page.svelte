<script lang="ts">
  import { createLoadGuard } from "$lib/loadGuard";
  import { goto } from "$app/navigation";
  import type { ProgressionResponse, EducationCourseDto } from "@tornscope/shared";
  import Countdown from "$lib/components/Countdown.svelte";
  import {
    formatKpiValue,
    formatNumberCompact,
    formatSignedNumberCompact,
    periodLabel,
  } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import * as td from "$lib/time-display.svelte.js";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { confidenceTitle } from "$lib/confidence";
  import { C, ct, LEGEND, GRID, timeAxis, valueAxis, dayLabel, axisTimeTooltip, MOTION } from "$lib/charts";

  let progression = $state<ProgressionResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  // Education section (2.8.2): client-side filter + search over the catalog
  // rows delivered in the progression payload.
  let eduFilter = $state<"all" | "completed" | "in_progress" | "remaining">("all");
  let eduQuery = $state("");
  const education = $derived(progression?.education ?? null);
  const eduFiltered = $derived.by(() => {
    if (!education) return [];
    const q = eduQuery.trim().toLowerCase();
    return education.courses.filter((c) => {
      if (eduFilter !== "all" && c.state !== eduFilter) return false;
      if (q && !`${c.name} ${c.categoryName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });
  function eduRewardLine(course: EducationCourseDto): string {
    const bits: string[] = [];
    if (course.reward.manualLabor) bits.push(`+${course.reward.manualLabor} manual`);
    if (course.reward.intelligence) bits.push(`+${course.reward.intelligence} int`);
    if (course.reward.endurance) bits.push(`+${course.reward.endurance} end`);
    bits.push(...course.reward.effects, ...course.reward.honors.map((h) => `Honor: ${h}`));
    return bits.join(" · ");
  }

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const res = await endpoints.progression(range);
      if (!guard.isCurrent(seq)) return; // a newer range superseded this response
      progression = res;
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

  // Human range headline (Phase: period-copy cleanup) — the period is named
  // once here instead of repeating in the masthead sentence and grid labels.
  // Ranges are TORN calendar days (UTC); "today" is reserved for the
  // profile-timezone day on the Today page, so 1d never says "today" here.
  const rangeHeadline = $derived.by(() => {
    switch (dateRange.preset) {
      case "today":
      case "1d":
        return "Training — current Torn day";
      case "7d":
        return "Training — last 7 Torn days";
      case "14d":
        return "Training — last 14 Torn days";
      case "30d":
        return "Training — last 30 Torn days";
      case "90d":
        return "Training — last 90 Torn days";
      case "this_month":
        return "Training — this month";
      case "prev_month":
        return "Training — last month";
      case "this_year":
        return "Training — this year";
      case "all":
        return "Training — all time";
      default:
        return "Training — selected range";
    }
  });

  // Conditional summary composition (Summary admission rule): a card must
  // answer "where am I / am I improving / what did it take" for the
  // SELECTED range. Gain/day appears only when a full day of history makes
  // it meaningful; gym-attributed appears only when the split is
  // informative (not when every gained stat is gym); awards live in
  // Milestones — a zero there never occupies a hero slot.
  const summaryCards = $derived.by(() => {
    const p = progression;
    if (!p) return [] as Array<{ label: string; value: string; provenance: "exact" | "derived" | "estimated"; tone?: "neutral" | "positive" | "negative" | "accent"; sub?: string | null }>;
    const cards: Array<{ label: string; value: string; provenance: "exact" | "derived" | "estimated"; tone?: "neutral" | "positive" | "negative" | "accent"; sub?: string | null }> = [];
    cards.push({ label: "Total battlestats", value: formatKpiValue(p.summary.totalBattlestats, formatNumberCompact), provenance: "exact", tone: "accent" });
    if (p.summary.totalDelta.value !== null) {
      const allGym =
        p.battlestats.attribution?.gym !== null &&
        p.battlestats.attribution?.gym === p.summary.totalDelta.value;
      cards.push({
        label: "Battlestat gain",
        value: formatSignedNumberCompact(p.summary.totalDelta.value),
        provenance: "derived",
        tone: p.summary.totalDelta.value >= 0 ? "positive" : "negative",
        sub:
          p.battlestats.changePct !== null
            ? `${p.battlestats.changePct >= 0 ? "+" : ""}${p.battlestats.changePct.toFixed(2)}%${allGym ? " · all gym-attributed" : ""}`
            : p.battlestats.baselineKind === "tracked_since"
              ? "since tracking began"
              : allGym
                ? "all gym-attributed"
                : null,
      });
    }
    if (p.summary.gainPerDay.value !== null) {
      cards.push({ label: "Gain per day", value: formatNumberCompact(p.summary.gainPerDay.value), provenance: "derived" });
    }
    const gym = p.battlestats.attribution?.gym ?? null;
    if (gym !== null && p.summary.totalDelta.value !== null && gym !== p.summary.totalDelta.value) {
      cards.push({ label: "Gym-attributed", value: "+" + formatNumberCompact(gym), provenance: "derived", sub: "of the battlestat gain" });
    }
    if (p.summary.sessions > 0) {
      cards.push({
        label: "Training",
        value: `${p.summary.sessions} session${p.summary.sessions === 1 ? "" : "s"}`,
        provenance: "estimated",
        sub: p.summary.energyTrained.value !== null ? `~${formatNumberCompact(p.summary.energyTrained.value)} E inferred` : null,
      });
    }
    return cards;
  });
  const summaryGridClass = $derived.by(() => {
    const n = summaryCards.length;
    if (n <= 2) return "md:grid-cols-2";
    if (n === 3) return "md:grid-cols-3";
    if (n === 4) return "md:grid-cols-4";
    return "md:grid-cols-5";
  });

  // Permission-aware sections: unavailable data must never render as zeros.
  const statAv = $derived(progression?.availability?.battlestats);
  const statBlocked = $derived(statAv !== undefined && !availabilityHasData(statAv));
  const energyAv = $derived(progression?.availability?.energy);
  const energyBlocked = $derived(energyAv !== undefined && !availabilityHasData(energyAv));

  /* --------------------------- battlestat chart --------------------------- */
  type StatKey = "strength" | "defense" | "speed" | "dexterity";
  // Identity colors are theme-tuned but stable across chart palettes —
  // series identity must survive palette switching.
  const STAT_META: Array<{ key: StatKey; label: string; color: string }> = $derived([
    { key: "strength", label: "Strength", color: ct().battlestats.strength },
    { key: "defense", label: "Defense", color: ct().battlestats.defense },
    { key: "speed", label: "Speed", color: ct().battlestats.speed },
    { key: "dexterity", label: "Dexterity", color: ct().battlestats.dexterity },
  ]);
  // Keys are static (only colors are theme-derived); capture once, no warning.
  const STAT_KEYS: StatKey[] = ["strength", "defense", "speed", "dexterity"];
  let visibleStats = $state<Set<StatKey>>(new Set(STAT_KEYS));
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
      times: shown.map((p) => p.t),
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
      tooltip: axisTimeTooltip(chartData.times),
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

  /** Xanax accounting: uses are exact from the drug log; the per-use amount
   *  is the documented +250 (estimated). Torn's energy bar can hold up to
   *  1,000, so a Xanax delivers even at a "full" natural bar — energy that
   *  cannot be placed between two snapshots is UNRESOLVED (still in the
   *  bar, consumed between polls, or taken before bar history began),
   *  never claimed as lost. */
  const xanaxLine = $derived.by(() => {
    const e = progression?.energy;
    if (!e?.xanax) return null;
    const { uses, estimatedDelivered: delivered, attributedToTraining } = e.xanax;
    const walkUnresolved = e.unresolvedGainsByCategory.find((c) => c.category === "Xanax (est.)")?.amount ?? 0;
    // Everything neither attributed to a session, nor walk-unresolved, nor
    // inside bar coverage predates bar history — delivered, but unplaceable.
    const beforeBars = Math.max(0, delivered - attributedToTraining - walkUnresolved);
    const parts: string[] = [];
    if (attributedToTraining > 0) parts.push(`~${formatNumberCompact(attributedToTraining)} E attributed to training`);
    if (walkUnresolved > 0) parts.push(`~${formatNumberCompact(walkUnresolved)} E unresolved between snapshots`);
    if (beforeBars > 0) parts.push(`~${formatNumberCompact(beforeBars)} E outside bar history (unresolved)`);
    return { uses, delivered, parts };
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
        <h2 id="prog-masthead" class="section-label !tracking-[0.12em]">{rangeHeadline}</h2>
        <div class="flex flex-wrap items-center gap-2">
          <span class="chip chip-quiet !border-border !text-[10px]" title="Battlestat values recorded by Torn, hourly">exact</span>
          <span class="chip chip-quiet !border-border !text-[10px]" title="Computed directly from exact observations">derived</span>
          <span class="chip chip-quiet !border-border !text-[10px]" title="Pattern-based conclusion — evidence always shown">inferred</span>
        </div>
      </div>
      <p class="mt-3 max-w-4xl font-display text-lg leading-relaxed text-fg sm:text-xl">
        {#if progression.summary.totalDelta.value !== null && progression.battlestats.baselineKind === 'tracked_since'}
          Battlestat tracking began {td.displayDate(progression.battlestats.trackedSince)} — inside this range — so the
          <span class="tnum font-semibold {progression.summary.totalDelta.value >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedNumberCompact(progression.summary.totalDelta.value)}</span>
          change covers only the tracked portion.
        {:else if progression.summary.totalDelta.value !== null}
          <span class="tnum font-semibold {progression.summary.totalDelta.value >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedNumberCompact(progression.summary.totalDelta.value)}</span>
          battlestats{#if progression.summary.gainPerDay.value !== null} — about {formatNumberCompact(progression.summary.gainPerDay.value)} per day{/if}.
        {:else if progression.battlestats.trackedSince !== null}
          Battlestat history is still accumulating — nothing in this range yet.
        {:else}
          Battlestat history starts with your first personal-stats sync.
        {/if}
      </p>
      <p class="mt-2 max-w-4xl text-sm leading-relaxed text-fg-muted">
        {#if progression.energy.covered}
          {#if progression.summary.energyTrained.value !== null}~{formatNumberCompact(progression.summary.energyTrained.value)} E trained across {progression.summary.sessions} session{progression.summary.sessions === 1 ? "" : "s"}{#if progression.summary.likelyJumps > 0}, including {progression.summary.likelyJumps} likely happy jump{progression.summary.likelyJumps === 1 ? "" : "s"}{/if}.{:else}{progression.summary.sessions} session{progression.summary.sessions === 1 ? "" : "s"} in this range.{/if}
        {:else}
          Energy analytics begin with the first bar snapshot — Torn only exposes bars live, so TornScope records them from now on.
        {/if}
      </p>
    </section>

    <!-- ═══ A · Battlestat progression ═══ -->
    <section class="space-y-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">A</span> Battlestat progression — hourly observations from Torn personal stats</h2>
        {#if progression.battlestats.trackedSince !== null}
          <span class="text-[11px] text-fg-faint">Tracked since {td.displayDate(progression.battlestats.trackedSince)}</span>
        {/if}
      </div>
      {#if statBlocked && statAv}
        <StateMessage
          state={availabilityMessage(statAv).state}
          title={availabilityMessage(statAv).title}
          hint={availabilityMessage(statAv).hint}
          action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
        />
      {:else}
        <!-- Conditional summary composition (UI-DESIGN §Summary admission):
             only meaningful, range-appropriate metrics occupy the grid —
             gain/day appears only when a full day of history exists, awards
             live in Milestones, and the grid renders however many cards
             earn a slot. -->
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel {summaryGridClass}">
          {#each summaryCards as card, i (card.label)}
            <div class={summaryCards.length % 2 === 1 && i === summaryCards.length - 1 ? "max-md:col-span-2 [&>div]:h-full bg-surface" : "bg-surface"}>
              <Stat label={card.label} value={card.value} provenance={card.provenance} confidence={progression.battlestats.confidence} confidenceTooltip={confidenceTitle(progression.battlestats.confidence)} tone={card.tone} sub={card.sub} />
            </div>
          {/each}
        </div>

        <!-- Attribution: total change split into gym / job / other. Non-gym
             sources must never be labeled gym gains (real-user finding #13). -->
        {#if progression.battlestats.attribution && progression.summary.totalDelta.value !== null && progression.summary.totalDelta.value !== 0}
          <div class="rounded-tile border border-border bg-surface px-5 py-3">
            <p class="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-faint">Attribution of the {period} change</p>
            <p class="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
              <span class="text-fg-muted">Gym-attributed <span class="tnum font-medium text-fg">{progression.battlestats.attribution.gym !== null ? `+${formatNumberCompact(progression.battlestats.attribution.gym)}` : "—"}</span></span>
              <span class="text-fg-muted">Job/company <span class="tnum font-medium text-fg" title="Exact cumulative job stat counter delta — battlestats that grew outside the gym">{progression.battlestats.attribution.job !== null ? `+${formatNumberCompact(progression.battlestats.attribution.job)}` : "—"}</span></span>
              <span class="text-fg-muted">Other/unattributed <span class="tnum font-medium text-fg" title="Friend-train stat amounts and movements no bracket can attribute">{progression.battlestats.attribution.other !== null ? `+${formatNumberCompact(progression.battlestats.attribution.other)}` : "—"}</span>{#if (progression.battlestats.attribution.friendTrains ?? 0) > 0}<span class="text-[10px] text-fg-faint"> · {progression.battlestats.attribution.friendTrains} stat trains received</span>{/if}</span>
            </p>
            <p class="mt-1 text-[11px] text-fg-faint">Total battlestat change is exact from snapshots; only the split is inferred. Job gains come from an exact Torn counter and are never counted as gym gains.</p>
          </div>
        {/if}

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
                      <td class="tnum text-right text-fg-muted">{stat.closing !== null ? formatNumberCompact(stat.closing) : "—"}</td>
                      <td class="tnum text-right text-fg-faint">{share !== null ? `${Math.round(share * 100)}%` : "—"}</td>
                      <td class="tnum text-right font-medium {stat.delta === null ? 'text-fg-faint' : stat.delta >= 0 ? 'text-positive' : 'text-negative'}">{stat.delta !== null ? formatSignedNumberCompact(stat.delta) : "—"}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Milestones" caption="Threshold crossings from exact observations — the window is shown when the exact moment is not known">
            {#if progression.profile.awardsDelta !== null && progression.profile.awardsDelta !== 0}
              <p class="mb-2.5 flex items-baseline justify-between gap-3 border-b border-border/60 pb-2.5 text-[13px]" title="Award and honor grants from Torn — each grants a merit point">
                <span class="text-fg">Awards earned</span>
                <span class="tnum font-medium text-positive">+{progression.profile.awardsDelta}{#if progression.profile.awards !== null}<span class="ml-1.5 text-[11px] text-fg-faint">{progression.profile.awards} total</span>{/if}</span>
              </p>
            {/if}
            {#if milestones.length === 0 && levelChanges.length === 0 && !(progression.profile.awardsDelta !== null && progression.profile.awardsDelta !== 0)}
              <StateMessage state="empty" compact title="No milestone crossings in this range" />
            {:else}
              <ul class="space-y-2.5 text-[13px]">
                {#each milestones.slice(0, 8) as m (m.kind + m.threshold + m.crossedBetween[0])}
                  <li class="flex items-baseline justify-between gap-3">
                    <span class="text-fg">{m.label} crossed {formatNumberCompact(m.threshold)}</span>
                    <span class="tnum text-[11px] text-fg-faint" title="Crossed between these two observations">{td.displayDate(m.crossedBetween[0])} → {td.displayDate(m.crossedBetween[1])}</span>
                  </li>
                {/each}
                {#each levelChanges as lv (lv.t)}
                  <li class="flex items-baseline justify-between gap-3">
                    <span class="text-fg">Level {lv.level}</span>
                    <span class="tnum text-[11px] text-fg-faint">{td.displayDate(lv.t)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </Panel>
        </div>
      {/if}
    </section>

    {#if education}
      <section class="space-y-4" aria-label="Education">
        <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">E</span> Education — current state and catalog progress</h2>
        <div class="grid gap-4 lg:grid-cols-3">
          <Panel title="Current course" caption="Live from Torn — exact completion time" class="lg:col-span-2">
            {#if education.currentCourse}
              <div class="flex items-baseline justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-[15px] font-semibold text-fg">{education.currentCourse.name}</p>
                  <p class="mt-0.5 text-[12px] text-fg-muted">{education.currentCourse.categoryName}</p>
                </div>
                <div class="shrink-0 text-right">
                  <Countdown seconds={education.currentCourse.remainingSeconds} style="clock" class="text-[17px] font-semibold" />
                  <p class="tnum mt-0.5 text-[11px] text-fg-faint">{td.displayDateTime(education.currentCourse.completesAt)}</p>
                </div>
              </div>
            {:else}
              <p class="text-[14px] text-fg-muted">No course in progress.</p>
            {/if}
            <p class="mt-3 text-[11px] text-fg-faint">
              Completed {education.completed} of {education.total} courses{education.inProgress > 0 ? ` · ${education.inProgress} in progress` : ""} · completion history is not published by Torn (current + completed state only).
            </p>
          </Panel>
          <Panel title="Category progress" caption="A category completes as a degree when every course is done">
            <ul class="space-y-2 text-[12px]">
              {#each education.categories as cat (cat.name)}
                <li>
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="truncate {cat.complete ? 'text-positive' : 'text-fg-muted'}">{cat.name}{cat.complete ? " ✓" : ""}</span>
                    <span class="tnum shrink-0 text-fg-faint">{cat.completed}/{cat.total}</span>
                  </div>
                  <div class="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div class="h-full rounded-full {cat.complete ? 'bg-positive' : 'bg-accent/70'}" style={`width:${Math.round((cat.completed / cat.total) * 100)}%`}></div>
                  </div>
                </li>
              {/each}
            </ul>
          </Panel>
        </div>
        <div class="grid gap-4 lg:grid-cols-2">
          <Panel title="Earned rewards" caption="From completed courses only — exact catalog values">
            <p class="tnum text-[15px] font-semibold text-fg">
              +{education.earned.manualLabor} manual · +{education.earned.intelligence} int · +{education.earned.endurance} end
            </p>
            <p class="tnum mt-1 text-[11px] text-fg-faint">{education.earned.effects.length} course effects · {education.earned.honors.length} honors earned</p>
          </Panel>
          <Panel title="Future rewards" caption="Remaining + in-progress courses — not yet earned">
            <p class="tnum text-[15px] font-semibold text-fg">
              +{education.future.manualLabor} manual · +{education.future.intelligence} int · +{education.future.endurance} end
            </p>
            <p class="tnum mt-1 text-[11px] text-fg-faint">{education.future.effects.length} course effects · {education.future.honors.length} honors available</p>
          </Panel>
        </div>
        <Panel title="Courses" caption="{education.completed} completed · {education.remaining} remaining of {education.total}">
          {#snippet actions()}
            <div class="flex flex-wrap items-center gap-2">
              <div class="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-1" role="group" aria-label="Education filter">
                {#each [["all", "All"], ["completed", "Completed"], ["in_progress", "In progress"], ["remaining", "Remaining"]] as [value, label] (value)}
                  <button
                    class={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${eduFilter === value ? "bg-accent/15 text-accent" : "text-fg-muted hover:text-fg"}`}
                    onclick={() => (eduFilter = value as typeof eduFilter)}
                  >{label}</button>
                {/each}
              </div>
              <input
                class="w-36 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
                placeholder="Search…"
                bind:value={eduQuery}
                aria-label="Search education courses"
              />
            </div>
          {/snippet}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Category</th>
                  <th>State</th>
                  <th class="hidden text-right md:table-cell">Days</th>
                  <th>Reward / effect</th>
                </tr>
              </thead>
              <tbody>
                {#each eduFiltered as course (course.id)}
                  <tr>
                    <td class="max-w-[220px] truncate text-fg" title={course.name}>{course.name}</td>
                    <td class="text-xs text-fg-muted">{course.categoryName}</td>
                    <td>
                      <span class={`chip ${course.state === "completed" ? "chip-positive" : course.state === "in_progress" ? "chip-accent" : ""}`}>
                        {course.state === "completed" ? "Completed" : course.state === "in_progress" ? "In progress" : "Remaining"}
                      </span>
                    </td>
                    <td class="tnum hidden text-right text-fg-muted md:table-cell">{course.durationDays ?? "—"}</td>
                    <td class="max-w-[320px] truncate text-xs text-fg-muted" title={eduRewardLine(course)}>{eduRewardLine(course) || "—"}</td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="px-4 py-4 text-center text-[13px] text-fg-faint">No courses match this filter.</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>
    {/if}

          <Panel title="Account progression" caption="Long-term counters from your stored personalstats history — exact snapshot deltas over the selected range">
            {#if !progression.accountCounters}
              <StateMessage state="empty" compact title="No personalstats history yet" hint="Hourly stat snapshots accumulate automatically while the sync runs." />
            {:else}
              {#if progression.accountCounters.primary.length === 0}
                <StateMessage state="empty" compact title="No known counters observed yet" />
              {:else}
                <ul class="space-y-2.5 text-[13px]">
                  {#each progression.accountCounters.primary as c (c.key)}
                    <li class="flex items-baseline justify-between gap-3">
                      <span class="text-fg">{c.label}</span>
                      <span class="flex items-baseline gap-2">
                        <span class="tnum text-[11px] text-fg-faint" title="Current total (Torn cumulative counter)">{c.current !== null ? formatNumberCompact(c.current) : "—"}</span>
                        {#if c.delta !== null && c.delta !== 0}
                          <span class="tnum font-medium {c.delta > 0 ? 'text-positive' : c.resetDetected ? 'text-warn' : 'text-negative'}"
                            title={c.resetDetected
                              ? "Torn's counter was observed resetting — the delta covers the period after the reset"
                              : c.delta > 0
                                ? "Exact snapshot delta over the selected range"
                                : "Counter decreased — shown as-is, never hidden"}>
                            {c.delta > 0 ? "+" : ""}{formatNumberCompact(c.delta)}{c.ratePerDay !== null ? ' · ' + formatNumberCompact(c.ratePerDay) + '/day' : ''}
                          </span>
                        {/if}
                      </span>
                    </li>
                  {/each}
                </ul>
                {#if progression.accountCounters.secondary.length > 0}
                  <details class="mt-3">
                    <summary class="cursor-pointer select-none text-[12px] font-medium text-fg-muted transition-colors hover:text-fg">
                      More progression stats ({progression.accountCounters.secondary.length})
                    </summary>
                    <ul class="mt-2.5 space-y-2.5 text-[13px]">
                      {#each progression.accountCounters.secondary as c (c.key)}
                        <li class="flex items-baseline justify-between gap-3">
                          <span class="text-fg-muted">{c.label}</span>
                          <span class="flex items-baseline gap-2">
                            <span class="tnum text-[11px] text-fg-faint">{c.current !== null ? formatNumberCompact(c.current) : "—"}</span>
                            {#if c.delta !== null && c.delta !== 0}
                              <span class="tnum font-medium {c.delta > 0 ? 'text-positive' : 'text-negative'}"
                                title={c.resetDetected ? 'Counter reset observed — delta covers the post-reset period' : 'Exact snapshot delta'}>
                                {c.delta > 0 ? '+' : ''}{formatNumberCompact(c.delta)}
                              </span>
                            {/if}
                          </span>
                        </li>
                      {/each}
                    </ul>
                  </details>
                {/if}
                <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
                  Counters are Torn's own cumulative personalstats values, snapshot-sampled hourly — provenance exact, deltas cover the tracked span.
                </p>
              {/if}
            {/if}
          </Panel>

    <!-- ═══ B · Training ═══ -->
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">B</span> Training — sessions inferred from energy declines and stat gains</h2>
      {#if progression.training.sessions.length === 0}
        <StateMessage state="empty" title="No training sessions inferred in this range" hint="Sessions need bar history (energy declines) and hourly stat snapshots. Both accumulate automatically." />
      {:else}
        <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
          <Stat label="Gain per energy (median)" value={progression.training.medianGainPerEnergy !== null ? progression.training.medianGainPerEnergy.toFixed(1) : "—"} provenance="estimated" confidence={progression.training.confidence} title="Observed battlestat gain divided by attributed training energy — an estimate, not an exact gym figure" />
          <Stat label="Training days" value={String(progression.training.daysTrained)} provenance="estimated" confidence={progression.training.confidence} sub={`${progression.summary.sessions} session${progression.summary.sessions === 1 ? "" : "s"}`} />
          <Stat label="Energy trained" value={progression.summary.energyTrained.value !== null ? `~${formatNumberCompact(progression.summary.energyTrained.value)}` : formatKpiValue(progression.summary.energyTrained, formatNumberCompact)} provenance="estimated" confidence={progression.training.confidence} sub={progression.training.avgEnergyPerTrainingDay !== null ? `~${formatNumberCompact(progression.training.avgEnergyPerTrainingDay)} per training day` : null} />
          <Stat label="Happy jumps" value={String(progression.happyJumps.jumps.length)} provenance="estimated" confidence={progression.happyJumps.confidence} sub={`${progression.summary.likelyJumps} likely`} />
        </div>

        {#if ratioSentence}
          <p class="rounded-tile border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
            Current gain per energy is <span class="font-medium text-fg">{ratioSentence}</span> — a personal comparison, never a universal judgment.
          </p>
        {/if}

        {#if progression.trainingIntelligence}
          {@const ti = progression.trainingIntelligence}
          <Panel
            title="Training intelligence"
            caption="Trailing windows anchored at the end of the selected range — same inferred sessions, compared side by side"
          >
            <div class="overflow-x-auto">
              <table class="tsv-table">
                <thead>
                  <tr>
                    <th>Window</th>
                    <th class="text-right">Sessions</th>
                    <th class="text-right">Energy (inferred)</th>
                    <th class="text-right">Stat gain</th>
                    <th class="text-right">Gain / E (median)</th>
                    <th class="text-right">Hours at cap</th>
                  </tr>
                </thead>
                <tbody>
                  {#each [ti.current, ti.previous, ti.baseline30d] as period (period.label)}
                    <tr>
                      <td>{period.label}</td>
                      <td class="text-right tnum">{period.sessions}</td>
                      <td class="text-right tnum">{period.energyTrained !== null ? `~${formatNumberCompact(period.energyTrained)}` : "—"}</td>
                      <td class="text-right tnum">{period.statGain !== null ? formatNumberCompact(period.statGain) : "—"}</td>
                      <td class="text-right tnum">{period.gainPerEnergyMedian !== null ? period.gainPerEnergyMedian.toFixed(1) : "—"}</td>
                      <td class="text-right tnum">{period.cappedHours > 0 ? `${Math.round(period.cappedHours)}h` : "—"}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div class="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
              {#if ti.records.bestGainPerEnergyDay}
                <span>Best gain/E day: <span class="tnum font-medium text-fg">{ti.records.bestGainPerEnergyDay.value.toFixed(1)}</span></span>
              {/if}
              {#if ti.records.bestStatGainDay}
                <span>Best gain day: <span class="tnum font-medium text-fg">{formatNumberCompact(ti.records.bestStatGainDay.value)}</span></span>
              {/if}
              {#if ti.records.bestWeek}
                <span>Best week: <span class="tnum font-medium text-fg">{formatNumberCompact(ti.records.bestWeek.value)}</span></span>
              {/if}
            </div>
            {#if ti.timeOfDay?.best}
              <p class="mt-3 rounded-tile border border-border bg-surface-2 px-4 py-2.5 text-xs leading-relaxed text-fg-muted">
                Sessions between <span class="font-medium text-fg">{ti.timeOfDay.best.label}</span> showed
                <span class="tnum font-medium text-fg">+{ti.timeOfDay.best.upliftPct.toFixed(0)}%</span> observed gain/E versus your 30-day median
                (over {ti.timeOfDay.best.sessions} sessions). Observational only — it does not imply the time of day caused the difference.
              </p>
            {/if}
          </Panel>
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
                  <th class="text-right">Energy (inferred)</th>
                  <th class="text-right">Gym gain</th>
                  <th class="text-right">Gain / E</th>
                  <th>Stat</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {#each progression.training.sessions.slice().reverse().slice(0, 12) as session (session.startedAt)}
                  <tr>
                    <td class="tnum whitespace-nowrap text-xs text-fg-faint"><span title={td.alternateTimeTooltip(session.startedAt)}>{td.displayDateTime(session.startedAt)}</span> → {td.displayTime(session.endedAt)}</td>
                    <td class="tnum text-right {session.energySpent !== null ? 'text-negative' : 'text-fg-faint'}" title={session.energySpent !== null ? "Bounded inference: includes Xanax energy delivered between snapshots; regeneration inside the burst is not separable" : undefined}>{session.energySpent !== null ? `~${formatNumberCompact(session.energySpent)}` : "—"}</td>
                    <td class="tnum text-right {session.gymGain !== null && session.gymGain > 0 ? 'text-positive' : 'text-fg-faint'}" title={session.nonGymJobGain > 0 ? `+${formatNumberCompact(session.totalGain ?? 0)} observed, of which ${formatNumberCompact(session.nonGymJobGain)} was job/company gains — not gym` : session.friendTrains > 0 ? `${session.friendTrains} stat trains received in the bracket — gym share not separable` : undefined}>{session.gymGain !== null ? `+${formatNumberCompact(session.gymGain)}` : "—"}{#if session.nonGymJobGain > 0}<span class="ml-1 text-[10px] text-fg-faint" title="Job/company stat gains inside the bracket — excluded from gym attribution">{formatNumberCompact(session.nonGymJobGain)} job</span>{/if}</td>
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
            Torn has no gym-training log: sessions are TornScope's inference from energy declines that no competing activity (like attacks) explains. Energy is a bounded estimate ("~") — Xanax energy delivered between snapshots is included and regeneration inside a burst is not separable. Gain shows the gym-attributable share; exact job/company gains are listed separately and never counted as gym.
          </p>
        </Panel>
      {/if}
    </section>


    <!-- ═══ C · Happy jumps ═══ -->
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">C</span> Happy jumps — inferred, evidence on request</h2>
      {#if progression.happyJumps.jumps.length === 0}
        <StateMessage state="empty" title="No happy jumps inferred in this range" hint="A jump needs a large training burst plus preparation evidence (Xanax cluster, Ecstasy, refill) — Torn has no direct happy-jump record." />
      {:else}
        <div class="space-y-4">
          {#each progression.happyJumps.jumps as jump (jump.trainedFrom)}
            <details class="group rounded-card border {jump.confidence === 'likely' ? 'border-accent/40' : 'border-border'} bg-surface shadow-panel">
              <summary class="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
                <div class="min-w-0">
                  <p class="text-[13px] font-semibold text-fg">
                    {td.displayDate(jump.trainedFrom)}
                    <span class="ml-2 font-normal text-fg-muted">Likely happy jump</span>
                    <span class="ml-2 chip {jump.confidence === 'likely' ? 'chip-positive' : 'chip-warning'} !px-1.5 !text-[9px] !uppercase">{jump.confidence}</span>
                  </p>
                  <p class="mt-1 text-[11.5px] text-fg-faint">
                    Preparation
                    {jump.xanaxCount > 0 ? `${jump.xanaxCount}× Xanax` : "—"}
                    {jump.ecstasyCount > 0 ? "· Ecstasy" : ""}
                    {jump.refillUsed ? "· Refill" : ""}
                    · Training {jump.energySpent !== null ? `${formatNumberCompact(jump.energySpent)} E` : "—"}
                    · Observed gain {jump.totalGain !== null ? `+${formatNumberCompact(jump.totalGain)}` : "—"}{jump.primaryStat === "mixed" ? " (mixed)" : jump.primaryStat ? ` ${jump.primaryStat.toUpperCase()}` : ""}
                  </p>
                </div>
                <span class="text-fg-faint transition-transform group-open:rotate-180">▾</span>
              </summary>
              <div class="grid gap-px overflow-hidden border-t border-border bg-border sm:grid-cols-4">
                <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Energy used</p><p class="tnum mt-1 text-lg font-semibold text-negative">{jump.energySpent !== null ? formatNumberCompact(jump.energySpent) : "—"}</p></div>
                <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Observed gain</p><p class="tnum mt-1 text-lg font-semibold text-positive">{jump.totalGain !== null ? `+${formatNumberCompact(jump.totalGain)}` : "—"}</p></div>
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
    <!-- ═══ D · Energy flow ═══ -->
    <section class="space-y-5">
      <h2 class="section-label text-[12px]"><span class="mr-2 text-accent">D</span> Energy flow — where it came from, where it went</h2>
      {#if energyBlocked && energyAv}
        <StateMessage
          state={availabilityMessage(energyAv).state}
          title={availabilityMessage(energyAv).title}
          hint={availabilityMessage(energyAv).hint}
          action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
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
                  <span class="tnum font-medium text-positive">+{formatNumberCompact(source.amount)}</span>
                </li>
              {/each}
              {#if progression.energy.sources.length === 0}
                <li class="text-fg-faint">No energy gains recorded in this range.</li>
              {/if}
              {#if xanaxLine}
                <li
                  class="border-t border-border/60 pt-2.5 text-[11px] leading-relaxed text-fg-faint"
                  title="Torn's Xanax gives +250 energy per use (documented game mechanic — the log itself carries no energy field), and Torn's energy bar can hold up to 1,000 — so a Xanax delivers in full even at a full natural bar. Energy not attributable to a specific training session is 'unresolved': still in the bar, consumed between snapshots, or taken before bar history began. It is never counted as lost."
                >
                  {xanaxLine.uses} Xanax taken · ~{formatNumberCompact(xanaxLine.delivered)} E delivered{#if xanaxLine.parts.length}{" — " + xanaxLine.parts.join(", ")}{/if}. Uses are exact from your drug log; +250 per use is the documented mechanic, not a per-use reading.
                </li>
              {/if}
            </ul>
            {#if progression.energy.potentialRegen !== null}
              <p class="mt-4 text-[11px] leading-relaxed text-fg-faint">
                Potential natural regeneration while full: ~{formatNumberCompact(progression.energy.potentialRegen)} (estimated from your observed regen rate of {progression.energy.regenPerHour !== null ? progression.energy.regenPerHour.toFixed(1) : "—"} per hour — never counted as banked energy).
              </p>
            {/if}
          </Panel>

          <div class="hidden items-center justify-center lg:flex" aria-hidden="true">
            <span class="text-2xl text-border-strong">→</span>
          </div>

          <Panel title="Energy out" caption="Inferred spend: observed declines plus delivered energy consumed between snapshots — unattributed stays unattributed">
            <ul class="space-y-2.5 text-[13px]">
              {#each progression.energy.uses as use (use.category)}
                <li class="flex items-baseline justify-between gap-3">
                  <span class="flex items-center gap-2 text-fg">
                    {use.category}
                    <ProvenanceBadge level={use.provenance} />
                  </span>
                  <span class="tnum font-medium text-negative">-{formatNumberCompact(use.amount)}</span>
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

        <Panel title="Energy reconciliation" caption="Opening plus delivered gains plus derived regeneration, minus inferred spend and unresolved gains, against what the bars show">
          <div class="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-border bg-border md:grid-cols-6">
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Opening energy</p><p class="tnum mt-1 text-lg font-semibold text-fg">{progression.energy.reconciliation.opening !== null ? progression.energy.reconciliation.opening : "—"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint" title="Delivered energy from logs (refills exact, Xanax +250 per use) inside bar coverage">Delivered gains</p><p class="tnum mt-1 text-lg font-semibold text-positive">{progression.energy.sources.filter((s) => s.category !== "Natural regen (derived)").reduce((sum, s) => sum + s.amount, 0) !== 0 ? `+${formatNumberCompact(progression.energy.sources.filter((s) => s.category !== "Natural regen (derived)").reduce((sum, s) => sum + s.amount, 0))}` : "0"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Derived regen</p><p class="tnum mt-1 text-lg font-semibold text-positive">{progression.energy.derivedRegen !== null ? `+${formatNumberCompact(progression.energy.derivedRegen)}` : "—"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint" title="Observed declines plus delivered energy credited inside them (consumption between snapshots)">Inferred spend</p><p class="tnum mt-1 text-lg font-semibold text-negative">{progression.energy.uses.reduce((sum, u) => sum + u.amount, 0) !== 0 ? `-${formatNumberCompact(progression.energy.uses.reduce((sum, u) => sum + u.amount, 0))}` : "0"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint" title="Delivered gains that cannot be placed between two snapshots — consumed, banked above the natural max, or wasted; not observable">Unresolved</p><p class="tnum mt-1 text-lg font-semibold text-fg-muted">{progression.energy.unresolvedGains !== null ? `±${formatNumberCompact(progression.energy.unresolvedGains)}` : "0"}</p></div>
            <div class="bg-surface p-4"><p class="text-[11px] font-medium text-fg-faint">Closing energy</p><p class="tnum mt-1 text-lg font-semibold text-fg">{progression.energy.reconciliation.closing !== null ? progression.energy.reconciliation.closing : "—"}</p></div>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-fg-faint">
            <span class="{energyQualityChip.cls} chip !px-1.5 !text-[9px] !uppercase">{energyQualityChip.label}</span>
            {#if capTimeSentence}<span>{capTimeSentence}.</span>{/if}
            {#if progression.energy.unresolvedGains !== null}
              <span title="Delivered gains (mostly Xanax) that cannot be placed between two snapshots. Verified mechanic: Torn's energy bar can hold up to 1,000, so a Xanax delivers in full even at a full natural bar — when the player trains before the next poll, the energy is consumed unobserved. Unresolved is not lost: it may have been spent, or may still be banked above the natural maximum.">{formatNumberCompact(progression.energy.unresolvedGains)} of delivered gains can't be placed between snapshots (consumed between polls, banked above the natural max, or wasted) — shown, never silently dropped.</span>
            {/if}
          </div>
        </Panel>
      {/if}
    </section>

  {/if}
</div>
