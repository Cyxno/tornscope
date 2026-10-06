<script lang="ts">
  import { createLoadGuard } from "$lib/loadGuard";
  import { goto } from "$app/navigation";
  import type { DrugsSummaryResponse } from "@tornscope/shared";
  import { TORN_DRUG_NAMES, formatMoneyCompact } from "@tornscope/shared";
  import { formatRelative } from "$lib/reltime";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, ct, TOOLTIP, LEGEND, GRID, timeAxis, countAxis, dayLabel, axisTimeTooltip, MOTION, surface, accentRgba } from "$lib/charts";
  import * as td from "$lib/time-display.svelte.js";

  let data = $state<DrugsSummaryResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  let selected = $state<string[]>([]);
  let selectAll = $state(true);

  function toggleDrug(name: string) {
    selected = selected.includes(name) ? selected.filter((d) => d !== name) : [...selected, name];
    selectAll = selected.length === 0;
  }

  function toggleAll() {
    selectAll = true;
    selected = [];
  }

  /** Freshness-aware tooltip: consumption value, not personal spend. */
  const xanaxValueTooltip = $derived.by(() => {
    const refreshed = data?.xanaxFunding.values.priceUpdatedAt
      ? ` Catalog market data refreshed ${formatRelative(data.xanaxFunding.values.priceUpdatedAt)}.`
      : "";
    return `Market value of all Xanax used at current catalog prices — a consumption value, NOT personal spend (sponsored Xanax costs you $0).${refreshed}`;
  });

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const res = await endpoints.drugsSummary({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to }, selectAll ? null : selected);
      if (!guard.isCurrent(seq)) return; // a newer range superseded this response
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
    void selectAll;
    void selected.length;
    void load();
  });

  const dailyOption = $derived.by(() => {
    if (!data || data.dailySeries.every((p) => p.good === 0 && p.bad === 0)) return null;
    return {
      ...MOTION,
      tooltip: axisTimeTooltip(data.dailySeries.map((p) => p.t)),
      legend: { ...LEGEND, data: ["Successful", "Overdose"], top: 0, right: 0 },
      grid: { ...GRID, bottom: 34 },
      dataZoom: [
        { type: "inside" },
        { type: "slider", height: 16, bottom: 4, borderColor: C.axisLine, backgroundColor: "transparent", fillerColor: accentRgba(0.08), handleStyle: { color: C.accent }, textStyle: { color: C.labelFaint } },
      ],
      xAxis: timeAxis(data.dailySeries.map((p) => dayLabel(p.t)), { boundaryGap: true }),
      yAxis: countAxis(),
      series: [
        { name: "Successful", type: "bar", stack: "use", data: data.dailySeries.map((p) => p.good), barMaxWidth: 14, itemStyle: { color: C.accent, borderRadius: [3, 3, 0, 0] } },
        { name: "Overdose", type: "bar", stack: "use", data: data.dailySeries.map((p) => p.bad), barMaxWidth: 14, itemStyle: { color: C.negative, borderRadius: [3, 3, 0, 0] } },
      ],
    };
  });

  const donutOption = $derived.by(() => {
    if (!data) return null;
    const rows = data.byDrug.filter((d) => d.uses > 0);
    if (rows.length === 0) return null;
    const palette = ct().palette;
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "item", formatter: (p: { name: string; value: number; percent: number }) => `${p.name}: ${p.value} use${p.value === 1 ? "" : "s"} (${p.percent}%)` },
      legend: { ...LEGEND, type: "scroll", orient: "vertical", right: 4, top: "middle" },
      series: [
        {
          type: "pie",
          radius: ["58%", "82%"],
          center: ["34%", "50%"],
          label: { show: false },
          itemStyle: { borderRadius: 4, borderColor: surface(), borderWidth: 2 },
          data: rows.map((d, i) => ({ name: d.drug, value: d.uses, itemStyle: { color: palette[i % palette.length] } })),
        },
      ],
    };
  });

  /**
   * Provenance split for the funding bar. Order is semantic: proven first,
   * then unknowns — the bar never implies unknown stock is personal spend.
   */
  const provenanceSegments = $derived.by(() => {
    if (!data || data.xanaxFunding.used === 0) return [];
    const f = data.xanaxFunding;
    const segs = [
      { key: "faction", label: "Faction-sponsored", count: f.confirmedFaction, color: "#3fd68f" },
      { key: "personal", label: "Confirmed personal", count: f.confirmedPersonal, color: "#2dd4bf" },
      { key: "other", label: "External source", count: f.confirmedOther, color: "#8fd6c0" },
      { key: "opening", label: "Opening inventory — origin unknown", count: f.openingInventoryUnknown, color: "#f0b24a" },
      { key: "unknown", label: "Unknown source", count: f.unknown, color: "#6e6e78" },
    ].filter((s) => s.count > 0);
    const total = segs.reduce((s, x) => s + x.count, 0) || 1;
    return segs.map((s) => ({ ...s, share: (s.count / total) * 100 }));
  });
</script>

<svelte:head><title>Drugs · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Personal · Habits"
    title="Substances & rehab"
    description="A behavioural record of every logged use — patterns, cost and consequence, estimated where Torn provides no exact figure."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  <!-- Substance filter: scrollable on phones, wrapped on wider screens -->
  <div class="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible sm:pb-0">
    <span class="section-label mr-1 hidden shrink-0 self-center sm:inline">Filter</span>
    <button
      class="chip shrink-0 cursor-pointer !py-1.5 text-xs {selectAll
        ? 'chip-accent'
        : 'hover:border-border-strong hover:text-fg'}"
      onclick={toggleAll}
    >
      All substances
    </button>
    {#each TORN_DRUG_NAMES as name (name)}
      <button
        class="chip shrink-0 cursor-pointer !py-1.5 text-xs {(selectAll || selected.includes(name))
          ? 'chip-accent'
          : 'hover:border-border-strong hover:text-fg'}"
        onclick={() => toggleDrug(name)}
        aria-pressed={selectAll || selected.includes(name)}
      >
        {name}
      </button>
    {/each}
  </div>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load drug analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    {@const histAv = data.availability?.history}
    {@const histBlocked = histAv !== undefined && !availabilityHasData(histAv)}
    {@const staleMsg = histAv && histAv.state === "stale_permission" ? availabilityMessage(histAv) : null}
    {#if staleMsg}
      <p class="rounded-tile border border-warning/30 bg-warning/5 px-5 py-3 text-xs leading-relaxed text-warning">
        <span class="font-medium">{staleMsg.title}.</span>
        {staleMsg.hint}
      </p>
    {/if}
    <!-- Quiet stat strip: open hairline columns, no box -->
    <dl class="grid grid-cols-2 gap-y-5 md:grid-cols-6 md:divide-x md:divide-border">
      <div class="md:pr-5">
        <dt class="text-[11px] font-medium text-fg-faint">Total uses</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-accent">{histBlocked ? "—" : data.overall.totalUses}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Xanax / day</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{histBlocked ? "—" : data.overall.xanaxPerDay !== null ? data.overall.xanaxPerDay : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">{data.overall.coveredDays !== null ? `${data.xanaxFunding.used} used (${data.xanaxFunding.used - data.xanaxFunding.overdoses} good) · ${data.overall.coveredDays} covered day${data.overall.coveredDays === 1 ? "" : "s"}` : ""}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Overdoses</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold {data.overall.overdoses > 0 ? 'text-negative' : 'text-fg'}">{histBlocked ? "—" : data.overall.overdoses}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">{histBlocked && data.overall.totalUses > 0 ? `${Math.round(data.overall.overdoseRate * 100)}% OD rate` : ""}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint" title="Consecutive successful uses of ANY drug since your last overdose (full recorded history up to the range end). Uses include only successful outcomes — an overdose resets the streak. Per-drug streaks: drill-down table below.">Good streak · all drugs</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-positive">{histBlocked ? "—" : data.overall.streaks ? data.overall.streaks.current : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-fg-faint">{data.overall.streaks && data.overall.streaks.lastOverdoseAt !== null ? `last OD ${formatRelative(data.overall.streaks.lastOverdoseAt)}` : data.overall.streaks?.lastUseAt !== null && data.overall.streaks ? "no overdose on record" : ""}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Longest streak</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{histBlocked ? "—" : data.overall.streaks ? data.overall.streaks.longest : "—"}</dd>
      </div>
      <div class="md:pl-5">
        <dt class="text-[11px] font-medium text-fg-faint" title={xanaxValueTooltip}>Est. Xanax consumption</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{histBlocked ? "—" : data.xanaxFunding.values.consumption !== null ? formatMoneyCompact(data.xanaxFunding.values.consumption) : "—"}</dd>
        <dd class="mt-0.5 text-[11px] text-warning">estimated</dd>
      </div>
    </dl>

    {#if histBlocked && histAv}
      <!-- Drug history needs User Logs: a permission state, never zeros -->
      <StateMessage
        state={availabilityMessage(histAv).state}
        title={availabilityMessage(histAv).title}
        hint={availabilityMessage(histAv).hint}
        action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
      />
    {/if}

    {#if !histBlocked}
    {#if data.xanaxFunding.used > 0}
      <!-- Provenance hero: the page's signature question, on open canvas -->
      <section class="section-rule" aria-label="Xanax provenance">
        <p class="section-label">Provenance</p>
        <p class="font-display mt-2 max-w-3xl text-[24px] font-medium leading-tight text-fg sm:text-[28px]">
          Where did <span class="tnum" data-xanax-used>{data.xanaxFunding.used}</span> Xanax come from?
        </p>

        <!-- Composition bar: proven classes first, unknowns last -->
        {#if provenanceSegments.length > 0}
          <div class="mt-5">
            <div class="flex h-4 gap-px overflow-hidden rounded-full bg-surface-2" role="img" aria-label="Xanax provenance split">
              {#each provenanceSegments as seg (seg.key)}
                <div style="width: {seg.share}%; background: {seg.color}" title="{seg.label}: {seg.count}"></div>
              {/each}
            </div>
            <p class="mt-1.5 text-[11px] text-fg-faint">{data.xanaxFunding.used} use{data.xanaxFunding.used === 1 ? "" : "s"} in range · proven sources first, unknowns last</p>
          </div>
        {/if}

        <!-- Segment ledger: dot + label + count + meaning, hairline rows -->
        <ul class="mt-6 grid gap-x-12 md:grid-cols-2">
          {#each provenanceSegments as seg (seg.key)}
            <li class="border-b border-border/60 py-3">
              <div class="flex flex-wrap items-baseline justify-between gap-2">
                <span class="flex items-center gap-2.5 text-[13.5px] font-medium text-fg">
                  <span class="h-2.5 w-2.5 rounded-sm" style="background: {seg.color}" aria-hidden="true"></span>
                  {seg.label}
                </span>
                <span class="tnum text-[15px] font-semibold text-fg">{seg.count} use{seg.count === 1 ? "" : "s"}<span class="ml-2 text-[11px] font-normal text-fg-faint">· {Math.round(seg.share)}%</span></span>
              </div>
              <p class="mt-1 pl-[18px] text-xs leading-relaxed text-fg-muted">
                {#if seg.key === "faction"}
                  Estimated value{data.xanaxFunding.values.factionSponsored !== null ? ` ${formatMoneyCompact(data.xanaxFunding.values.factionSponsored)}` : ""} — proven from faction armory evidence. <span class="font-medium text-fg">Personal cost $0.</span>
                {:else if seg.key === "personal"}
                  Estimated value{data.xanaxFunding.values.confirmedPersonal !== null ? ` ${formatMoneyCompact(data.xanaxFunding.values.confirmedPersonal)}` : ""} — drawn from recorded purchases.
                {:else if seg.key === "opening"}
                  Estimated value{data.xanaxFunding.values.openingInventory !== null ? ` ${formatMoneyCompact(data.xanaxFunding.values.openingInventory)}` : ""} — held when the range began; origin not proven, so not labelled personal spend.
                {:else if seg.key === "other"}
                  Gift/trade evidence — not personal spend.
                {:else}
                  Not attributable to any recorded supply.
                {/if}
              </p>
            </li>
          {/each}
        </ul>
        {#if data.xanaxFunding.confirmedFaction === 0 && data.xanaxFunding.confirmedPersonal === 0 && data.xanaxFunding.confirmedOther === 0 && data.xanaxFunding.openingInventoryUnknown === 0}
          <p class="mt-3 text-xs text-fg-muted">All uses lack traceable supply records.</p>
        {/if}

        <div class="mt-5 max-w-3xl space-y-1.5 text-[11px] leading-relaxed text-fg-faint">
          <p>
            Values are estimated at the current catalog market price and are consumption values, not personal spend.
            Sponsored Xanax costs you $0.
          </p>
          {#if data.xanaxFunding.armoryHistory.available}
            <p>
              Faction armory history covers events since {td.displayDate(data.xanaxFunding.armoryHistory.earliestAt)} ({data.xanaxFunding.armoryHistory.events} armory events stored);
              uses before that date cannot be matched to armory evidence and stay unclassified rather than assumed personal.
            </p>
          {:else}
            <p class="text-warning">
              Faction armory history is not available through the connected API source, so faction sponsorship cannot be
              detected — uses stay unattributed rather than assumed personal.
            </p>
          {/if}
        </div>
      </section>
    {/if}

    <!-- Hero chart -->
    <Panel title="Daily drug use" caption="Successful uses vs overdoses — scroll or pinch inside the chart to zoom" flush>
      {#if !dailyOption}
        <StateMessage state="empty" compact title="No drug events in this range" hint="Events appear as Torn logs sync, or adjust your substance filter." />
      {:else}
        <Chart option={dailyOption} height={380} />
      {/if}
    </Panel>

    <!-- Breakdown + rehab -->
    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="By substance" caption="Share of total uses" flush class="h-full">
        {#if !donutOption}
          <StateMessage state="empty" compact title="No uses to break down" />
        {:else}
          <Chart option={donutOption} height={280} />
        {/if}
      </Panel>

      <Panel title="Rehab" caption="One Torn Rehab log = one visit; sessions come from Torn's explicit rehab-times count" class="h-full">
        <div class="grid grid-cols-3 gap-4">
          <div>
            <p class="text-[11px] font-medium text-fg-faint" title="One Torn Rehab log row is one visit — Torn pre-groups each visit into a single log">Visits</p>
            <p class="tnum mt-1 text-xl font-semibold text-fg">{data.rehab.visits}</p>
            <p class="tnum text-[11px] text-fg-faint">
              {#if data.rehab.sessions !== null}{data.rehab.sessions} session{data.rehab.sessions === 1 ? "" : "s"}{#if data.rehab.sessionsUnavailable > 0} · {data.rehab.sessionsUnavailable} unknown{/if}{:else}Sessions unavailable{/if}
            </p>
          </div>
          <div>
            <p class="text-[11px] font-medium text-fg-faint" title="Mean of Torn's explicit per-visit session counts (rehab_times)">Sessions / visit</p>
            <p class="tnum mt-1 text-xl font-semibold text-fg">{data.rehab.averageSessionsPerVisit ?? "—"}</p>
            <p class="tnum text-[11px] text-fg-faint">{data.rehab.averageCostPerSession.value !== null ? `${formatMoneyCompact(data.rehab.averageCostPerSession.value).replace("-", "")}/session` : "cost/session unavailable"}</p>
          </div>
          <div>
            <p class="text-[11px] font-medium text-fg-faint">Total spend</p>
            <p class="tnum mt-1 text-xl font-semibold text-negative">{data.rehab.totalSpend.value !== null ? `-${formatMoneyCompact(data.rehab.totalSpend.value).replace("-", "")}` : "—"}</p>
            <p class="tnum text-[11px] text-fg-faint">{data.rehab.averageCostPerVisit.value !== null ? `${formatMoneyCompact(data.rehab.averageCostPerVisit.value).replace("-", "")}/visit` : ""}</p>
          </div>
        </div>
        {#if data.rehab.sessionsUnavailable > 0 && data.rehab.sessions === null}
          <p class="mt-3 rounded-tile border border-warning/30 bg-warning/5 px-4 py-2 text-[11px] leading-relaxed text-warning">
            Torn's logs for this range did not carry the per-visit session count, so sessions are shown as unavailable —
            never inferred from log counts or money.
          </p>
        {/if}
        {#if (data.rehab.addictionPointsRemoved ?? 0) > 0}
          <dl class="mt-4 grid grid-cols-3 gap-4 border-t border-border pt-3">
            <div>
              <p class="text-[11px] font-medium text-fg-faint" title="Sum of the explicit addiction-points removals recorded in the rehab logs">AP removed</p>
              <p class="tnum mt-1 text-lg font-semibold text-fg">{data.rehab.addictionPointsRemoved}</p>
              <p class="text-[11px] text-fg-faint">{data.rehab.addictionPointsKnownVisits ?? 0} visit{(data.rehab.addictionPointsKnownVisits ?? 0) === 1 ? "" : "s"} with AP data</p>
            </div>
            <div>
              <p class="text-[11px] font-medium text-fg-faint" title="Total spend ÷ total removed AP — only shown when every costed visit carries an AP value">Cost / AP</p>
              <p class="tnum mt-1 text-lg font-semibold text-fg">{data.rehab.costPerAddictionPoint?.value !== null && data.rehab.costPerAddictionPoint?.value !== undefined ? formatMoneyCompact(data.rehab.costPerAddictionPoint.value) : "—"}</p>
              <p class="text-[11px] text-fg-faint">{data.rehab.costPerAddictionPoint?.value != null ? "derived" : "needs AP on all costed visits"}</p>
            </div>
            <div>
              <p class="text-[11px] font-medium text-fg-faint" title="Median cost of your most recent costed visits — rehab pricing scales with addiction level, so this is an estimate">Est. next visit</p>
              <p class="tnum mt-1 text-lg font-semibold text-fg">{data.rehab.estimatedNextCost?.value !== null && data.rehab.estimatedNextCost?.value !== undefined ? formatMoneyCompact(data.rehab.estimatedNextCost.value) : "—"}</p>
              <p class="text-[11px] text-warning">{data.rehab.estimatedNextCost?.value != null ? "estimated" : ""}</p>
            </div>
          </dl>
        {/if}
        {#if data.rehab.visitTrend.length >= 2}
          <div class="mt-4">
            <p class="text-[11px] font-medium text-fg-faint">Cost per visit (oldest → newest)</p>
            <div class="mt-2 flex items-end gap-1.5">
              {#each data.rehab.visitTrend.slice(-16) as visit, i (visit.startedAt)}
                {@const maxCost = Math.max(...data.rehab.visitTrend.slice(-16).map((t) => t.cost ?? 0), 1)}
                <div class="group relative flex-1" title="{td.displayDateTime(visit.startedAt)} · {visit.sessions !== null ? `${visit.sessions} session${visit.sessions === 1 ? '' : 's'}` : 'sessions unavailable'} · total {visit.cost !== null ? `-${formatMoneyCompact(visit.cost)}` : 'cost unknown'}{visit.costPerSession !== null ? ` · ${formatMoneyCompact(visit.costPerSession)}/session` : ''}">
                  {#if visit.cost !== null}
                    <div class="w-full rounded-t bg-negative/60 transition-colors group-hover:bg-negative" style="height: {Math.max(4, Math.round((visit.cost / maxCost) * 64))}px"></div>
                  {:else}
                    <div class="w-full rounded-t border border-dashed border-border-strong bg-surface-2" style="height: 4px" title="Cost unknown"></div>
                  {/if}
                </div>
              {/each}
            </div>
            <p class="mt-1 text-[11px] text-fg-faint">
              Each bar = one visit's TOTAL cost (all its sessions included — Torn reports the visit total directly).
              Hover a bar for its session count and cost per session. A hollow bar means the log carried no cost.
            </p>
          </div>
        {/if}
        {#if data.rehab.recent.length === 0}
          <div class="mt-4">
            <StateMessage state="empty" compact title="No rehab visits in this range" />
          </div>
        {:else}
          {@const anyPercent = data.rehab.recent.some((v) => v.rehabPercent !== null)}
          <ul class="mt-5 divide-y divide-border">
            {#each data.rehab.recent.slice(0, 6) as visit (visit.occurredAt)}
              {@const trend = data.rehab.visitTrend.find((t) => t.startedAt === visit.occurredAt)}
              <li class="flex items-baseline justify-between gap-3 py-2.5">
                <span class="tnum text-[13px] text-fg-muted">{td.displayDateTime(visit.occurredAt)}</span>
                <span class="text-[13px] text-fg">{trend?.sessions !== null && trend?.sessions !== undefined ? `${trend.sessions} session${trend.sessions === 1 ? "" : "s"}` : "sessions unavailable"}</span>
                {#if anyPercent}
                  <span class="text-[13px] text-fg">{visit.rehabPercent !== null ? `${visit.rehabPercent}%` : "—"}</span>
                {/if}
                <!-- Rehab is an expense: always rendered negative/red like the money ledger -->
                <span class="tnum text-[13px] font-medium text-negative">{visit.cost !== null ? `-${formatMoneyCompact(visit.cost).replace("-", "")}` : "—"}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </Panel>
    </section>

    <!-- Per-drug cost table -->
    <Panel title="Cost per substance" caption="Estimated from Torn item market prices">
      {#if data.byDrug.length === 0}
        <StateMessage state="empty" compact title="Nothing to cost yet" />
      {:else}
        <div class="overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Substance</th>
                <th class="text-right">Uses</th>
                <th class="text-right">Overdoses</th>
                <th class="text-right">Streak</th>
                <th class="text-right">Longest</th>
                <th class="text-right">Last use</th>
                <th class="hidden md:table-cell text-right">Last OD</th>
                <th class="text-right">Share</th>
                <th class="text-right">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {#each data.byDrug as row (row.drug)}
                <tr>
                  <td class="font-medium text-fg">{row.drug}</td>
                  <td class="tnum text-right text-fg-muted">{row.uses}</td>
                  <td class="tnum text-right {row.overdoses > 0 ? 'text-negative' : 'text-fg-faint'}">{row.overdoses}</td>
                  <td class="tnum text-right {(row.currentStreak ?? 0) > 0 ? 'text-positive' : 'text-fg-faint'}" title="Consecutive successful uses since the last overdose">{row.currentStreak ?? 0}</td>
                  <td class="tnum text-right text-fg-muted">{row.longestStreak ?? 0}</td>
                  <td class="tnum text-right text-fg-muted">{row.lastUseAt !== null && row.lastUseAt !== undefined ? formatRelative(row.lastUseAt) : "—"}</td>
                  <td class="hidden md:table-cell tnum text-right text-fg-muted">{row.lastOverdoseAt !== null && row.lastOverdoseAt !== undefined ? formatRelative(row.lastOverdoseAt) : "never"}</td>
                  <td class="tnum text-right text-fg-muted">{(row.shareOfTotal * 100).toFixed(0)}%</td>
                  <td class="tnum text-right text-fg-muted">{row.estimatedCost !== null ? formatMoneyCompact(row.estimatedCost) : "—"}</td>
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
