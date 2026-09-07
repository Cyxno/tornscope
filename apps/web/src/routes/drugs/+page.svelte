<script lang="ts">
  import type { DrugsSummaryResponse } from "@tornscope/shared";
  import { TORN_DRUG_NAMES, formatMoneyCompact, formatDateTime, formatDate } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import { C, TOOLTIP, LEGEND, GRID, timeAxis, dayLabel } from "$lib/charts";

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

  async function load() {
    loading = true;
    error = null;
    try {
      data = await endpoints.drugsSummary({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to }, selectAll ? null : selected);
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
    void selectAll;
    void selected.length;
    void load();
  });

  const dailyOption = $derived.by(() => {
    if (!data || data.dailySeries.every((p) => p.good === 0 && p.bad === 0)) return null;
    return {
      tooltip: { ...TOOLTIP, trigger: "axis" },
      legend: { ...LEGEND, data: ["Successful", "Overdose"], top: 0, right: 0 },
      grid: { ...GRID, bottom: 34 },
      dataZoom: [
        { type: "inside" },
        { type: "slider", height: 16, bottom: 4, borderColor: C.axisLine, backgroundColor: "transparent", fillerColor: "rgba(45,212,191,0.08)", handleStyle: { color: C.accent }, textStyle: { color: C.labelFaint } },
      ],
      xAxis: timeAxis(data.dailySeries.map((p) => dayLabel(p.t))),
      yAxis: { type: "value", minInterval: 1, axisLabel: { color: C.label, fontSize: 10.5 }, splitLine: { lineStyle: { color: C.splitLine } }, axisLine: { show: false } },
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
    const palette = [C.accent, C.violet ?? "#a78bfa", C.positive, C.warning, C.pink ?? "#f472b6", "#818cf8", C.accentStrong, "#94a3b8", "#c084fc", "#5eead4", "#fca5a5"];
    return {
      tooltip: { ...TOOLTIP, trigger: "item", formatter: "{b}: {c} uses ({d}%)" },
      legend: { ...LEGEND, type: "scroll", orient: "vertical", right: 4, top: "middle" },
      series: [
        {
          type: "pie",
          radius: ["58%", "82%"],
          center: ["34%", "50%"],
          label: { show: false },
          itemStyle: { borderRadius: 4, borderColor: "#151518", borderWidth: 2 },
          data: rows.map((d, i) => ({ name: d.drug, value: d.uses, itemStyle: { color: palette[i % palette.length] } })),
        },
      ],
    };
  });
</script>

<svelte:head><title>Drugs · TornScope</title></svelte:head>

<div class="space-y-10">
  <PageHeader
    eyebrow="Personal · Habits"
    title="Substances & rehab"
    description="A behavioural record of every logged use — patterns, cost and consequence, estimated where Torn provides no exact figure."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  <!-- Substance filter -->
  <div class="flex flex-wrap items-center gap-2">
    <span class="mr-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">Filter</span>
    <button
      class="rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all {selectAll
        ? 'border-accent/40 bg-accent/10 text-accent'
        : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg'}"
      onclick={toggleAll}
    >
      All substances
    </button>
    {#each TORN_DRUG_NAMES as name (name)}
      <button
        class="rounded-full border px-3.5 py-1.5 text-xs transition-all {(selectAll || selected.includes(name))
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg'}"
        onclick={() => toggleDrug(name)}
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
      <p class="rounded-xl border border-warning/30 bg-warning/5 px-5 py-3 text-xs leading-relaxed text-warning">
        <span class="font-medium">{staleMsg.title}.</span>
        {staleMsg.hint}
      </p>
    {/if}
    <!-- Quiet stat strip -->
    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-5">
      <Stat label="Total uses" value={histBlocked ? "—" : String(data.overall.totalUses)} provenance="exact" tone="accent" />
      <Stat
        label="Xanax / day"
        value={histBlocked ? "—" : data.overall.xanaxPerDay !== null ? String(data.overall.xanaxPerDay) : "—"}
        provenance="derived"
        sub={data.overall.coveredDays !== null ? `${data.xanaxFunding.used} used · ${data.overall.coveredDays} covered days${data.overall.coverage === "partial" ? " · partial" : ""}` : null}
      />
      <Stat label="Overdoses" value={histBlocked ? "—" : String(data.overall.overdoses)} provenance="exact" tone={data.overall.overdoses > 0 ? "negative" : "neutral"} />
      <Stat
        label="Estimated consumption value"
        value={histBlocked ? "—" : data.xanaxFunding.values.consumption !== null ? formatMoneyCompact(data.xanaxFunding.values.consumption) : "—"}
        provenance="estimated"
        title="Market value of all Xanax used at current catalog prices. This is consumption value — NOT what you personally spent (sponsored Xanax costs you $0)."
      />
      <Stat
        label="Avg value / use"
        value={histBlocked ? "—" : data.xanaxFunding.values.unitPrice !== null ? formatMoneyCompact(data.xanaxFunding.values.unitPrice) : "—"}
        provenance="estimated"
        title="Current catalog market price per Xanax — an estimated consumption value, not your purchase cost."
      />
    </div>

    {#if histBlocked && histAv}
      <!-- Drug history needs User Logs: a permission state, never zeros -->
      <StateMessage
        state={availabilityMessage(histAv).state}
        title={availabilityMessage(histAv).title}
        hint={availabilityMessage(histAv).hint}
        action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
      />
    {/if}

    {#if !histBlocked}
    {#if data.xanaxFunding.used > 0}
      <div class="space-y-3 rounded-xl border border-border bg-surface px-5 py-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <p class="text-[13px] font-medium text-fg">Xanax used</p>
          <p class="tnum text-[13px] font-semibold text-fg">{data.xanaxFunding.used}</p>
        </div>
        <div class="flex flex-wrap items-baseline justify-between gap-2 border-t border-border/60 pt-2.5">
          <p class="text-[13px] text-fg-muted" title="Market value of ALL Xanax used at current catalog prices — a consumption value, not your personal spend.">
            Estimated consumption value
          </p>
          <p class="tnum text-[13px] font-semibold text-fg" data-xanax-consumption-value>
            {data.xanaxFunding.values.consumption !== null ? formatMoneyCompact(data.xanaxFunding.values.consumption) : "—"}
          </p>
        </div>

        {#if data.xanaxFunding.confirmedFaction > 0}
          <div class="rounded-xl border border-positive/25 bg-positive/5 px-4 py-3 text-xs leading-relaxed text-fg-muted">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-[13px] font-medium text-positive">Faction-sponsored</p>
              <p class="tnum text-[13px] font-semibold text-positive">{data.xanaxFunding.confirmedFaction}</p>
            </div>
            <p class="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <span>Estimated value{data.xanaxFunding.values.factionSponsored !== null ? ` ${formatMoneyCompact(data.xanaxFunding.values.factionSponsored)}` : ""}</span>
              <span class="font-semibold text-fg">Personal cost $0</span>
            </p>
            <p class="mt-0.5 text-fg-faint">Proven from faction armory evidence at the logged moment — supplied by your faction, not purchased by you.</p>
          </div>
        {/if}

        {#if data.xanaxFunding.confirmedPersonal > 0}
          <div class="rounded-xl border border-border bg-bg-raise px-4 py-3 text-xs leading-relaxed text-fg-muted">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-[13px] font-medium text-fg">Confirmed personal</p>
              <p class="tnum text-[13px] font-semibold text-fg">{data.xanaxFunding.confirmedPersonal}</p>
            </div>
            <p class="mt-1">Estimated value{data.xanaxFunding.values.confirmedPersonal !== null ? ` ${formatMoneyCompact(data.xanaxFunding.values.confirmedPersonal)}` : ""} — drawn from recorded purchases.</p>
          </div>
        {/if}

        {#if data.xanaxFunding.openingInventoryUnknown > 0}
          <div class="rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-xs leading-relaxed text-fg-muted">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <p class="text-[13px] font-medium text-warning">Opening inventory — origin unknown</p>
              <p class="tnum text-[13px] font-semibold text-warning">{data.xanaxFunding.openingInventoryUnknown}</p>
            </div>
            <p class="mt-1">Estimated value{data.xanaxFunding.values.openingInventory !== null ? ` ${formatMoneyCompact(data.xanaxFunding.values.openingInventory)}` : ""} — stock you already held when this range began; its origin is not proven by records, so it is not labeled personal spend.</p>
          </div>
        {/if}

        {#if data.xanaxFunding.confirmedOther > 0}
          <p class="text-xs text-fg-muted">{data.xanaxFunding.confirmedOther} from an external source (gift/trade evidence).</p>
        {/if}
        {#if data.xanaxFunding.unknown > 0}
          <p class="text-xs text-warning">{data.xanaxFunding.unknown} unknown source.</p>
        {/if}
        {#if data.xanaxFunding.confirmedFaction === 0 && data.xanaxFunding.confirmedPersonal === 0 && data.xanaxFunding.confirmedOther === 0 && data.xanaxFunding.openingInventoryUnknown === 0}
          <p class="text-xs text-fg-muted">All uses lack traceable supply records.</p>
        {/if}

        <p class="border-t border-border/60 pt-2.5 text-[11px] leading-relaxed text-fg-faint">
          Values are estimated at the current catalog market price and are consumption values, not personal spend.
          Classification uses a stock ledger over all recorded purchases, travel hauls, gifts and faction armory events —
          never just activity inside the selected range. Sponsored Xanax costs you $0.
        </p>
        {#if data.xanaxFunding.armoryHistory.available}
          <p class="text-[11px] text-fg-faint">
            Faction armory history covers events since {formatDate(data.xanaxFunding.armoryHistory.earliestAt)} ({data.xanaxFunding.armoryHistory.events} armory events stored);
            uses before that date cannot be matched to armory evidence and stay unclassified rather than assumed personal.
          </p>
        {:else}
          <p class="text-[11px] text-warning">
            Faction armory history is not available through the connected API source, so faction sponsorship cannot be
            detected — uses stay unattributed rather than assumed personal.
          </p>
        {/if}
      </div>
    {/if}

    <!-- Hero chart -->
    <Panel title="Daily drug use" caption="Successful uses vs overdoses — scroll or pinch inside the chart to zoom" flush>
      {#if !dailyOption}
        <StateMessage state="empty" title="No drug events in this range" hint="Events appear as Torn logs sync, or adjust your substance filter." />
      {:else}
        <Chart option={dailyOption} height={400} />
      {/if}
    </Panel>

    <!-- Breakdown + rehab -->
    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="By substance" caption="Share of total uses">
        {#if !donutOption}
          <StateMessage state="empty" title="No uses to break down" />
        {:else}
          <Chart option={donutOption} height={280} />
        {/if}
      </Panel>

      <Panel title="Rehab" caption="One Torn Rehab log = one visit; sessions come from Torn's explicit rehab-times count">
        <div class="grid grid-cols-3 gap-4">
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint" title="One Torn Rehab log row is one visit — Torn pre-groups each visit into a single log">Visits</p>
            <p class="tnum mt-1 text-xl font-semibold text-fg">{data.rehab.visits}</p>
            <p class="tnum text-[11px] text-fg-faint">
              {#if data.rehab.sessions !== null}{data.rehab.sessions} sessions{#if data.rehab.sessionsUnavailable > 0} · {data.rehab.sessionsUnavailable} unknown{/if}{:else}Sessions unavailable{/if}
            </p>
          </div>
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint" title="Mean of Torn's explicit per-visit session counts (rehab_times)">Sessions / visit</p>
            <p class="tnum mt-1 text-xl font-semibold text-fg">{data.rehab.averageSessionsPerVisit ?? "—"}</p>
            <p class="tnum text-[11px] text-fg-faint">{data.rehab.averageCostPerSession.value !== null ? `${formatMoneyCompact(data.rehab.averageCostPerSession.value).replace("-", "")}/session` : "cost/session unavailable"}</p>
          </div>
          <div>
            <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Total spend</p>
            <p class="tnum mt-1 text-xl font-semibold text-negative">{data.rehab.totalSpend.value !== null ? `-${formatMoneyCompact(data.rehab.totalSpend.value).replace("-", "")}` : "—"}</p>
            <p class="tnum text-[11px] text-fg-faint">{data.rehab.averageCostPerVisit.value !== null ? `${formatMoneyCompact(data.rehab.averageCostPerVisit.value).replace("-", "")}/visit` : ""}</p>
          </div>
        </div>
        {#if data.rehab.sessionsUnavailable > 0 && data.rehab.sessions === null}
          <p class="mt-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-2 text-[11px] leading-relaxed text-warning">
            Torn's logs for this range did not carry the per-visit session count, so sessions are shown as unavailable —
            never inferred from log counts or money.
          </p>
        {/if}
        {#if data.rehab.visitTrend.length >= 2}
          <div class="mt-4">
            <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Cost per visit (oldest → newest)</p>
            <div class="mt-2 flex items-end gap-1.5">
              {#each data.rehab.visitTrend.slice(-16) as visit, i (visit.startedAt)}
                {@const maxCost = Math.max(...data.rehab.visitTrend.slice(-16).map((t) => t.cost ?? 0), 1)}
                <div class="group relative flex-1" title="{formatDateTime(visit.startedAt)} · {visit.sessions !== null ? `${visit.sessions} session${visit.sessions === 1 ? '' : 's'}` : 'sessions unavailable'} · total {visit.cost !== null ? `-${formatMoneyCompact(visit.cost)}` : 'cost unknown'}{visit.costPerSession !== null ? ` · ${formatMoneyCompact(visit.costPerSession)}/session` : ''}">
                  <div class="w-full rounded-t bg-negative/60 transition-colors group-hover:bg-negative" style="height: {Math.max(4, Math.round(((visit.cost ?? 0) / maxCost) * 64))}px"></div>
                </div>
              {/each}
            </div>
            <p class="mt-1 text-[11px] text-fg-faint">
              Each bar = one visit's TOTAL cost (all its sessions included — Torn reports the visit total directly).
              Hover a bar for its session count and cost per session.
            </p>
          </div>
        {/if}
        {#if data.rehab.recent.length === 0}
          <div class="mt-4">
            <StateMessage state="empty" title="No rehab visits in this range" />
          </div>
        {:else}
          {@const anyPercent = data.rehab.recent.some((v) => v.rehabPercent !== null)}
          <ul class="mt-5 divide-y divide-border">
            {#each data.rehab.recent.slice(0, 6) as visit (visit.occurredAt)}
              {@const trend = data.rehab.visitTrend.find((t) => t.startedAt === visit.occurredAt)}
              <li class="flex items-baseline justify-between gap-3 py-2.5">
                <span class="tnum text-[13px] text-fg-muted">{formatDateTime(visit.occurredAt)}</span>
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
        <StateMessage state="empty" title="Nothing to cost yet" />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2.5 pr-4 font-medium">Substance</th>
                <th class="py-2.5 pr-4 text-right font-medium">Uses</th>
                <th class="py-2.5 pr-4 text-right font-medium">Overdoses</th>
                <th class="py-2.5 pr-4 text-right font-medium">Share</th>
                <th class="py-2.5 text-right font-medium">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {#each data.byDrug as row (row.drug)}
                <tr class="border-b border-border/50 transition-colors last:border-0 hover:bg-surface-2/50">
                  <td class="py-2.5 pr-4 font-medium text-fg">{row.drug}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{row.uses}</td>
                  <td class="tnum py-2.5 pr-4 text-right {row.overdoses > 0 ? 'text-negative' : 'text-fg-faint'}">{row.overdoses}</td>
                  <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{(row.shareOfTotal * 100).toFixed(0)}%</td>
                  <td class="tnum py-2.5 text-right text-fg-muted">{row.estimatedCost !== null ? formatMoneyCompact(row.estimatedCost) : "—"}</td>
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
