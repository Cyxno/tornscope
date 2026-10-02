<script lang="ts">
  import type { EnergySummaryResponse, EnergyProvenance } from "@tornscope/shared";
  import { formatNumberCompact, formatDecimal } from "@tornscope/shared";
  import { createLoadGuard } from "$lib/loadGuard";
  import { deepAnalytics, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";
  import { availabilityHasData } from "$lib/capabilities";
  import { C, LEGEND, GRID, timeAxis, countAxis, dayLabel, axisTimeTooltip, MOTION, accentRgba } from "$lib/charts";
  import * as td from "$lib/time-display.svelte.js";

  let data = $state<EnergySummaryResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const res = await deepAnalytics.energySummary({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to });
      if (!guard.isCurrent(seq)) return;
      data = res;
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

  const energy = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : formatNumberCompact(Math.round(v)));

  const provenanceNote: Record<EnergyProvenance, string> = {
    exact: "exact — read from Torn's own log payload",
    derived: "derived — deterministic from exact observations",
    estimated: "estimated — documented game convention, not a recorded value",
    inferred: "bounded inference — bar declines prove the outflow, logs cannot attribute it",
  };

  const chartOption = $derived.by(() => {
    if (!data || data.daily.length === 0) return null;
    const buckets = data.daily;
    const labels = buckets.map((p) => dayLabel(p.t));
    return {
      ...MOTION,
      tooltip: axisTimeTooltip(buckets.map((p) => p.t), (v) => `${formatNumberCompact(Number(v))} E`),
      legend: { ...LEGEND, data: ["Gained", "Spent", "Lost"], top: 0, right: 0 },
      grid: { ...GRID, bottom: 34 },
      dataZoom: [
        { type: "inside" },
        { type: "slider", height: 16, bottom: 4, borderColor: C.axisLine, backgroundColor: "transparent", fillerColor: accentRgba(0.08), handleStyle: { color: C.accent }, textStyle: { color: C.labelFaint } },
      ],
      xAxis: timeAxis(labels, { boundaryGap: true }),
      yAxis: countAxis(),
      series: [
        { name: "Gained", type: "bar", stack: "energy", data: buckets.map((p) => Math.round(p.gained)), barMaxWidth: 16, itemStyle: { color: C.positive, borderRadius: [3, 3, 0, 0] } },
        { name: "Spent", type: "bar", stack: "energy", data: buckets.map((p) => Math.round(p.spent)), barMaxWidth: 16, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
        { name: "Lost", type: "bar", stack: "energy", data: buckets.map((p) => Math.round(p.lost)), barMaxWidth: 16, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });

  const coverageCopy = $derived.by(() => {
    if (!data) return null;
    const c = data.coverage;
    if (c.quality === "unavailable") {
      return "No bar history in this range — sources and losses are still exact where logged, but the balance and inference rows are withheld instead of guessed.";
    }
    const share = c.accountedShare !== null ? `${Math.round(c.accountedShare * 100)}%` : null;
    if (share === null) return "Bar history covers this range, but no energy outflow was observed — nothing to attribute.";
    return `${share} of the observed energy outflow is explicitly attributed by logs (gym, overdoses); the remainder is bounded inference (attacks, reviving, unlogged uses) and stays labelled as such.`;
  });
</script>

<svelte:head><title>Energy · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Personal · Deep analytics"
    title="Energy accounting"
    description="Where your energy came from and where it went — exact where Torn's logs record it, honestly bounded where they do not."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load energy analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    {@const logsAv = data.availability?.logs}
    {@const logsBlocked = logsAv !== undefined && !availabilityHasData(logsAv)}

    <!-- Energy balance: the page's summary — five open columns, no box -->
    <dl class="grid grid-cols-2 gap-y-5 md:grid-cols-5 md:divide-x md:divide-border">
      <div class="md:pr-5">
        <dt class="text-[11px] font-medium text-fg-faint" title={provenanceNote[data.balance.generated.provenance]}>Natural regen</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{energy(data.balance.generated.value)}</dd>
        <dd class="mt-0.5"><ProvenanceBadge level={data.balance.generated.provenance} /></dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Refills + Xanax + energy drinks delivered inside the range">Gained externally</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-positive">{energy(data.balance.gainedExternally.value)}</dd>
        <dd class="mt-0.5"><ProvenanceBadge level={data.balance.gainedExternally.provenance} /></dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Gym is exact from logs; the rest is bounded bar-decline inference — withheld when there is no bar coverage">Energy spent</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{energy(data.balance.spent.value)}</dd>
        <dd class="mt-0.5"><ProvenanceBadge level={data.balance.spent.provenance} /></dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Overdose energy losses, exact from the logs' own energy_decreased values">Energy lost</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold {data.balance.lost.value > 0 ? 'text-negative' : 'text-fg'}">{energy(data.balance.lost.value)}</dd>
        <dd class="mt-0.5"><ProvenanceBadge level={data.balance.lost.provenance} /></dd>
      </div>
      <div class="md:pl-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Generated + gained − spent − lost. Only shown when bar history covers the range — never a partial guess">Net energy</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{energy(data.balance.net.value)}</dd>
        <dd class="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-fg-faint">{data.balance.net.value === null ? "uncovered" : "net of all four"}</dd>
      </div>
    </dl>

    {#if logsBlocked && logsAv}
      <StateMessage state="permission" title="Full energy history needs the User Logs permission" hint="Energy sources and losses are read from your own stored Torn logs. Grant the log selection in Settings to deepen this page." />
    {/if}

    {#if coverageCopy}
      <p class="rounded-tile border border-border bg-surface px-5 py-3 text-xs leading-relaxed text-fg-muted">
        <span class="font-medium text-fg">Coverage:</span>
        {coverageCopy}
      </p>
    {/if}

    <!-- Hero chart: daily/weekly/monthly gained vs spent vs lost -->
    <Panel title="Energy over time" caption="Gained vs spent vs lost per {data.chartInterval === 'day' ? 'day' : data.chartInterval === 'week' ? 'week' : 'month'} — scroll or pinch inside the chart to zoom" flush>
      {#if !chartOption}
        <StateMessage state="empty" compact title="No energy activity in this range" hint="Activity appears as Torn logs and bar snapshots sync, or widen the date range." />
      {:else}
        <Chart option={chartOption} height={380} />
      {/if}
    </Panel>

    <!-- Drill-down: sources / uses / losses -->
    <section class="grid gap-6 lg:grid-cols-3">
      <Panel title="Sources" caption="Where the energy came from" class="h-full">
        {#if data.sources.length === 0}
          <StateMessage state="empty" compact title="No energy gains in this range" />
        {:else}
          <ul class="divide-y divide-border">
            {#each data.sources as row (row.category)}
              <li class="flex items-baseline justify-between gap-3 py-2.5">
                <div>
                  <p class="text-[13.5px] font-medium text-fg">{row.label}</p>
                  <p class="text-[11px] text-fg-faint">
                    {row.events > 0 ? `${row.events} event${row.events === 1 ? "" : "s"}` : "derived from bar observations"}
                    {#if row.pointsUsed}{` · ${formatNumberCompact(row.pointsUsed)} points`}{/if}
                  </p>
                </div>
                <div class="text-right">
                  <p class="tnum text-[15px] font-semibold text-fg">{energy(row.amount)} E</p>
                  <p class="text-[11px] text-fg-faint">{row.share !== null ? `${Math.round(row.share * 100)}% of total` : ""}</p>
                </div>
              </li>
            {/each}
          </ul>
          <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
            Xanax energy applies the documented +250 per use — normal-use logs carry no energy field. Points spent on refills are exact from the log.
          </p>
        {/if}
      </Panel>

      <Panel title="Uses" caption="Where the energy went" class="h-full">
        {#if data.uses.length === 0}
          <StateMessage state="empty" compact title="No energy use observed in this range" />
        {:else}
          <ul class="divide-y divide-border">
            {#each data.uses as row (row.category)}
              <li class="flex items-baseline justify-between gap-3 py-2.5">
                <div>
                  <p class="text-[13.5px] font-medium text-fg">{row.label}</p>
                  <p class="text-[11px] text-fg-faint">{row.events > 0 ? `${row.events} recorded event${row.events === 1 ? "" : "s"}` : "bounded inference"}</p>
                </div>
                <div class="text-right">
                  <p class="tnum text-[15px] font-semibold text-fg">{row.provenance === "inferred" ? "~" : ""}{energy(row.amount)} E</p>
                  <p class="text-[11px] text-fg-faint">{row.share !== null ? `${Math.round(row.share * 100)}% of outflow` : ""}</p>
                </div>
              </li>
            {/each}
          </ul>
          <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
            Gym energy is exact from Torn's gym-train logs. Attack/revive use cannot be read from logs — it appears only as a bounded share of observed bar declines.
          </p>
        {/if}
      </Panel>

      <Panel title="Losses" caption="Overdose energy drained, exact from the logs" class="h-full">
        {#if data.losses.length === 0}
          <StateMessage state="empty" compact title="No overdose energy losses in this range" hint="Only overdoses whose payload records an energy drain count — never an invented loss." />
        {:else}
          <ul class="divide-y divide-border">
            {#each data.losses as row (row.category)}
              <li class="flex items-baseline justify-between gap-3 py-2.5">
                <div>
                  <p class="text-[13.5px] font-medium text-fg">{row.label} overdose</p>
                  <p class="text-[11px] text-fg-faint">{row.events} event{row.events === 1 ? "" : "s"}</p>
                </div>
                <p class="tnum text-[15px] font-semibold text-negative">-{energy(row.amount)} E</p>
              </li>
            {/each}
          </ul>
        {/if}
      </Panel>
    </section>

    <!-- Intelligence strip -->
    <Panel title="Energy intelligence" caption="Derived habits over this range — labelled estimates stay estimates">
      <dl class="grid grid-cols-2 gap-y-5 md:grid-cols-4 md:divide-x md:divide-border">
        <div class="md:pr-5">
          <dt class="text-[11px] font-medium text-fg-faint">Average energy / day</dt>
          <dd class="tnum mt-1 text-lg font-semibold text-fg">{data.intelligence.averageEnergyPerDay.value !== null ? formatNumberCompact(Math.round(data.intelligence.averageEnergyPerDay.value)) + " E" : "—"}</dd>
          <dd class="text-[11px] text-fg-faint">derived — regen + gains over covered days</dd>
        </div>
        <div class="md:px-5">
          <dt class="text-[11px] font-medium text-fg-faint" title="Xanax uses per calendar day in the range">Xanax / day</dt>
          <dd class="tnum mt-1 text-lg font-semibold text-fg">{data.intelligence.xanaxPerDay.value !== null ? formatDecimal(data.intelligence.xanaxPerDay.value, 1) : "—"}</dd>
          <dd class="text-[11px] text-warning">estimated</dd>
        </div>
        <div class="md:px-5">
          <dt class="text-[11px] font-medium text-fg-faint" title="Exact from each refill log's own payload">Refills used</dt>
          <dd class="tnum mt-1 text-lg font-semibold text-fg">{data.intelligence.refillCount}</dd>
          <dd class="text-[11px] text-fg-faint">{formatNumberCompact(data.intelligence.refillEnergy)} E{data.intelligence.refillPointsSpent !== null ? ` · ${formatNumberCompact(data.intelligence.refillPointsSpent)} points` : ""}</dd>
        </div>
        <div class="md:pl-5">
          <dt class="text-[11px] font-medium text-fg-faint" title="Lower bound of natural energy generated while your bar sat pinned at maximum — estimated from your observed regen rate">Regen lost at cap</dt>
          <dd class="tnum mt-1 text-lg font-semibold text-fg">{data.intelligence.potentialRegenWhileCapped.value !== null ? `~${formatNumberCompact(Math.round(data.intelligence.potentialRegenWhileCapped.value))} E` : "—"}</dd>
          <dd class="text-[11px] text-fg-faint">{data.intelligence.cappedHoursObserved > 0 ? `${formatDecimal(data.intelligence.cappedHoursObserved, 1)}h observed at cap` : "never capped"}</dd>
        </div>
      </dl>
    </Panel>

    <p class="text-[11px] leading-relaxed text-fg-faint">
      History was last refreshed {td.displayDateTime(data.generatedAt)}. Deep analytics read your locally ingested history — opening this page never triggers Torn API calls.
      Sources: refills and energy drinks are exact (<code class="text-fg-muted">energy_increased</code>), gym is exact (<code class="text-fg-muted">energy_used</code>),
      overdose losses are exact (<code class="text-fg-muted">energy_decreased</code>), Xanax applies the documented +250 convention. Bar coverage: {data.coverage.coveredFrom !== null ? `${td.displayDate(data.coverage.coveredFrom)} → ${td.displayDate(data.coverage.coveredTo)}` : "none in range"}{data.coverage.truncated ? " (truncated)" : ""}.
    </p>
  {/if}
</div>
