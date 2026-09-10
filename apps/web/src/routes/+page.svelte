<script lang="ts">
  import type { DashboardResponse, TodayResponse, DailySummaryResponse } from "@tornscope/shared";
  import {
    formatMoneyCompact,
    formatKpiValue,
    periodLabel,
    formatDate,
    formatSignedMoneyCompact,
  } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import LiveNow from "$lib/components/LiveNow.svelte";
  import { dateRange, me } from "$lib/state.svelte";
  import { clientPermissionMessage } from "$lib/capabilities";
  import { confidenceTitle } from "$lib/confidence";
  import { formatRelative, formatClock, greetingForHour } from "$lib/reltime";
  import ConfidenceBadge from "$lib/components/ConfidenceBadge.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { C, TOOLTIP, GRID, timeAxis, valueAxis, dayLabel, hourLabel, tealArea, MOTION } from "$lib/charts";

  /**
   * Overview — "the record". Composition, not a card grid:
   * masthead (greeting + data health) → live-state sentence → net-worth hero
   * with the chart integrated into the open canvas → today's story as a
   * signed ledger → recent activity ledger → quiet beyond-money rows.
   */

  let data = $state<DashboardResponse | null>(null);
  let today = $state<TodayResponse | null>(null);
  let todaySummary = $state<DailySummaryResponse | null>(null);
  let myOcs = $state<Array<{ name: string; tier: number | null; status: string; readyAt: number | null; myParticipation: boolean }> | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  async function load() {
    loading = true;
    error = null;
    try {
      const [dash, todayRes, summaryRes, ocsRes] = await Promise.all([
        endpoints.dashboard({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to }),
        endpoints.today().catch(() => null),
        endpoints.dailySummary().catch(() => null),
        endpoints.factionOcs({ preset: "30d" }).catch(() => null),
      ]);
      data = dash;
      today = todayRes;
      todaySummary = summaryRes;
      myOcs = ocsRes?.ocs.filter((o) => o.myParticipation && o.state === "active") ?? null;
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

  const greeting = $derived(greetingForHour(new Date().getUTCHours()));

  const statusLine = $derived.by(() => {
    if (!today) return null;
    const s = today.player.status;
    const state = s.description || s.details || s.state;
    return [state, today.player.level !== null ? `Level ${today.player.level}` : null].filter(Boolean).join(" · ");
  });

  /* Hero net worth split into currency symbol + magnitude */
  const nw = $derived.by(() => {
    const value = data?.netWorth.value ?? null;
    if (value === null || value === undefined) return null;
    const formatted = formatMoneyCompact(value);
    return { symbol: formatted.slice(0, 1), magnitude: formatted.slice(1) };
  });

  const networthOption = $derived.by(() => {
    if (!data || data.networthSeries.length === 0) return null;
    const interval = data.range.interval;
    return {
      ...MOTION,
      tooltip: { ...TOOLTIP, trigger: "axis" },
      grid: { ...GRID, top: 8, bottom: 0 },
      xAxis: timeAxis(data.networthSeries.map((p) => (interval === "hour" ? hourLabel(p.t) : dayLabel(p.t)))),
      yAxis: { ...valueAxis(), splitNumber: 4 },
      series: [
        {
          name: "Net worth",
          type: "line",
          data: data.networthSeries.map((p) => p.total),
          // Sparse early history must be visible as real points, not a guess.
          showSymbol: data.networthSeries.length < 40,
          smooth: 0.25,
          lineStyle: { color: C.accent, width: 2 },
          areaStyle: tealArea(),
        },
      ],
    };
  });

  /* Today story: drivers scaled to the largest absolute movement */
  const drivers = $derived(todaySummary?.netWorth.drivers ?? []);
  const driverMax = $derived(Math.max(1, ...drivers.map((d) => Math.abs(d.magnitude ?? 0))));

  // Permission gates: never a fake zero when the key cannot see the data.
  const caps = $derived(me.data?.capabilities ?? null);
  const logsBlocked = $derived(clientPermissionMessage(caps, "money_cash_flow"));
  const attacksBlocked = $derived(clientPermissionMessage(caps, "combat_history"));
  const networthBlocked = $derived(clientPermissionMessage(caps, "networth_history"));
</script>

<svelte:head><title>Overview · TornScope</title></svelte:head>

<div class="space-y-10">
  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load your dashboard" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    <!-- ── 1 · Masthead: greeting + range, data health quiet at the right ── -->
    <header class="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div class="min-w-0">
        <p class="section-label">Overview</p>
        <h1 class="font-display mt-2 text-[32px] font-medium leading-[1.1] text-fg sm:text-[38px]">
          {greeting}{today?.player.name ? `, ${today.player.name}` : ""}.
        </h1>
        <p class="mt-1.5 flex flex-wrap items-center gap-x-2 text-[13px] text-fg-muted">
          {#if statusLine}
            <span>{statusLine}</span>
            <span class="text-border-strong" aria-hidden="true">·</span>
          {/if}
          <span class="inline-flex items-center gap-1.5 text-fg-faint">
            <span class="h-1.5 w-1.5 rounded-full {me.data?.syncHealth.running ? 'bg-accent live-dot' : me.data?.syncHealth.lastSuccessAt ? 'bg-positive' : 'bg-fg-faint'}"></span>
            {#if me.data?.syncHealth.lastSuccessAt}
              data synced {formatRelative(me.data.syncHealth.lastSuccessAt)}
            {:else}
              awaiting first sync
            {/if}
          </span>
          <a href="/sync" class="text-fg-faint underline decoration-border underline-offset-2 transition-colors hover:text-fg-muted">health</a>
        </p>
      </div>
      <div class="flex min-w-0 max-w-full items-center gap-3">
        <SegmentedDateRange />
      </div>
    </header>

    <!-- ── 2 · Live now: one sentence, ticks not boxes ── -->
    <LiveNow today={today} ocs={myOcs} onOpenToday={() => (window.location.href = "/today")} />

    <!-- ── 3 · Net-worth hero: numeral + integrated chart on open canvas ── -->
    <section class="section-rule" aria-label="Net worth">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="section-label">Net worth</span>
          <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">exact · official Torn figure</span>
          <ConfidenceBadge meta={data.confidence?.networth} tooltip={confidenceTitle(data.confidence?.networth, data.lastSyncAt !== null ? `last sync ${formatRelative(data.lastSyncAt)}` : undefined)} />
        </div>
        {#if data.extendedWealth.value !== null}
          <p class="text-xs text-fg-faint" title="Official Torn net worth plus wealth Torn does not count in that figure.">
            Extended wealth <span class="tnum font-medium text-fg-muted">{formatMoneyCompact(data.extendedWealth.value)}</span>
            {#if data.extendedWealth.factionBalance !== null}
              · incl. {formatMoneyCompact(data.extendedWealth.factionBalance)} faction balance
            {/if}
          </p>
        {/if}
      </div>

      <div class="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        {#if nw}
          <p class="hero-num tnum text-fg">
            <span class="mr-1 text-[0.55em] font-medium text-fg-muted">{nw.symbol}</span>{nw.magnitude}
          </p>
        {:else}
          <p class="font-display text-4xl text-fg-faint">No snapshot yet</p>
        {/if}
        <p class="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13.5px]">
          {#if data.networthCoverage === "none"}
            <span class="tnum font-semibold text-fg-muted">Insufficient history</span>
            <span class="text-fg-faint">— change needs two snapshots in range</span>
          {:else}
            <span
              class="tnum text-lg font-semibold {data.networthChange.value === null
                ? 'text-fg-muted'
                : data.networthChange.value >= 0
                  ? 'text-positive'
                  : 'text-negative'}"
            >
              {data.networthChange.value === null ? "—" : formatSignedMoneyCompact(data.networthChange.value)}
            </span>
            {#if data.networthChangePct !== null}
              <span class="tnum text-fg-muted">{data.networthChangePct >= 0 ? "+" : ""}{data.networthChangePct.toFixed(2)}%</span>
            {/if}
            <span class="text-fg-faint" title="Snapshot delta from official Torn net worth: includes item/stock/property price moves, cash and asset movement. Not a profit figure.">
              · snapshots {data.financial.netWorthMeasuredFrom !== null ? formatDate(data.financial.netWorthMeasuredFrom) : "—"} → {data.financial.netWorthMeasuredTo !== null ? formatDate(data.financial.netWorthMeasuredTo) : "now"}{data.networthCoverage === "partial" ? " · partial coverage" : ""}
            </span>
          {/if}
        </p>
      </div>

      <!-- The trend IS the hero: full-width, no panel chrome -->
      <div class="mt-4">
        {#if networthBlocked}
          <StateMessage state="permission" compact title={networthBlocked.title} hint={networthBlocked.hint} />
        {:else if !networthOption}
          <div class="flex h-40 items-center justify-center text-[13px] text-fg-faint">
            Snapshots appear as the worker runs — no net-worth history in this range yet.
          </div>
        {:else}
          <Chart option={networthOption} height={280} />
        {/if}
      </div>

      <!-- Open hairline strip: period movement, no outer border -->
      <dl class="mt-6 grid grid-cols-2 gap-y-5 md:grid-cols-4 md:divide-x md:divide-border">
        <div class="md:pr-6">
          <dt class="flex items-center gap-2 text-[11px] font-medium text-fg-faint">
            Cash on hand <ConfidenceBadge meta={data.confidence?.networth} />
          </dt>
          <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{formatKpiValue(data.cash)}</dd>
        </div>
        <div class="md:px-6">
          <dt class="text-[11px] font-medium text-fg-faint">{period} cash received</dt>
          <dd class="tnum mt-1 text-[22px] font-semibold text-positive">{formatKpiValue(data.financial.cashInflow)}</dd>
          <dd class="mt-0.5 text-[11px] text-fg-faint">earned {formatMoneyCompact(data.financial.cashReceived?.earned.total ?? data.financial.trueIncome)} · asset sales {formatMoneyCompact(data.financial.cashReceived?.assetSales.total ?? data.financial.assetSales)}</dd>
        </div>
        <div class="md:px-6">
          <dt class="text-[11px] font-medium text-fg-faint">{period} cash spent</dt>
          <dd class="tnum mt-1 text-[22px] font-semibold text-negative">{formatKpiValue(data.financial.cashOutflow)}</dd>
          <dd class="mt-0.5 text-[11px] text-fg-faint">true expenses {formatMoneyCompact(data.financial.trueExpense)} · asset purchases {formatMoneyCompact(data.financial.assetPurchases)}</dd>
        </div>
        <div class="md:pl-6">
          <dt class="text-[11px] font-medium text-fg-faint">{period} net wallet movement</dt>
          <dd class="tnum mt-1 text-[22px] font-semibold {data.wallet.walletInflow - data.wallet.walletOutflow >= 0 ? 'text-positive' : 'text-negative'}">
            {formatSignedMoneyCompact(data.wallet.walletInflow - data.wallet.walletOutflow)}
          </dd>
          <dd class="mt-0.5 text-[11px] text-fg-faint">
            {#if data.wallet.coverage !== "unavailable" && data.wallet.startingCash !== null && data.wallet.unreconciled !== null}
              reconciliation {formatSignedMoneyCompact(data.wallet.unreconciled)}
            {:else}
              cash arithmetic — not profit
            {/if}
          </dd>
        </div>
      </dl>
    </section>

    <!-- ── 4 · Today story: the day as a signed ledger ── -->
    <section class="section-rule" aria-label="Today's story">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 class="section-label">Today — {todaySummary ? formatDate(todaySummary.range.from) : formatDate(Math.floor(Date.now() / 1000))}</h2>
          {#if todaySummary?.ongoingDay}<span class="chip chip-warning !py-0 !text-[9px]">day in progress</span>{/if}
          {#if todaySummary}
            <ConfidenceBadge meta={todaySummary.overallConfidence} tooltip={confidenceTitle(todaySummary.overallConfidence)} />
          {/if}
        </div>
        <a href="/today" class="text-link shrink-0 text-xs font-medium">The full day →</a>
      </div>

      {#if !todaySummary}
        <p class="mt-4 text-[13px] text-fg-faint">The day's recap appears after the first sync — see <a href="/sync" class="text-link">Sync Status</a>.</p>
      {:else}
        <div class="mt-5 grid grid-cols-1 gap-10 lg:grid-cols-5">
          <!-- Why it moved: signed diverging bars -->
          <div class="min-w-0 lg:col-span-3">
            <p class="text-[13px] font-medium text-fg">
              Net worth
              <span class="tnum ml-1 text-[15px] font-semibold {todaySummary.netWorth.delta === null ? 'text-fg-faint' : todaySummary.netWorth.delta >= 0 ? 'text-positive' : 'text-negative'}">
                {todaySummary.netWorth.delta === null ? "insufficient history" : formatSignedMoneyCompact(todaySummary.netWorth.delta)}
              </span>
              {#if todaySummary.netWorth.changePct !== null && todaySummary.netWorth.delta !== null}
                <span class="tnum ml-1 text-xs text-fg-muted">{todaySummary.netWorth.changePct >= 0 ? "+" : ""}{todaySummary.netWorth.changePct.toFixed(2)}%</span>
              {/if}
            </p>
            <p class="mt-1 text-[11px] text-fg-faint">
              Likely contributors — recorded movements, not causes
              {#if todaySummary.netWorth.coverage === "partial"} · covers the tracked portion only{/if}.
            </p>
            <ul class="mt-4 space-y-2.5">
              {#each drivers as driver (driver.kind + driver.label)}
                {@const magnitude = driver.magnitude}
                <li class="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                  <span class="min-w-0 truncate text-[13px] {driver.certainty === 'unexplained' ? 'text-warning' : 'text-fg-muted'}">
                    {driver.label}
                    {#if driver.certainty === "estimated"}<span class="ml-1 text-[10px] uppercase tracking-wide text-fg-faint">est.</span>{/if}
                  </span>
                  <span class="hidden items-center gap-2 sm:flex" aria-hidden="true">
                    <!-- Diverging bar around a centre rule -->
                    <span class="flex h-4 w-full items-center">
                      <span class="flex w-1/2 justify-end">
                        {#if magnitude !== null && magnitude < 0}
                          <span class="delta-bar bg-negative/70" style="width: {Math.max(4, (Math.abs(magnitude) / driverMax) * 100)}%"></span>
                        {/if}
                      </span>
                      <span class="h-3 w-px bg-border-strong"></span>
                      <span class="flex w-1/2">
                        {#if magnitude !== null && magnitude >= 0}
                          <span class="delta-bar bg-positive/70" style="width: {Math.max(4, (magnitude / driverMax) * 100)}%"></span>
                        {/if}
                      </span>
                    </span>
                  </span>
                  <span class="tnum text-right text-[13px] font-medium {magnitude === null ? 'text-fg-faint' : magnitude >= 0 ? 'text-positive' : 'text-negative'}">
                    {magnitude === null ? "—" : formatSignedMoneyCompact(magnitude)}
                  </span>
                </li>
              {/each}
              {#if drivers.length === 0}
                <li class="text-[13px] text-fg-faint">A quiet day — nothing notable recorded.</li>
              {/if}
            </ul>
          </div>

          <!-- The three lenses, condensed to quiet rows -->
          <div class="min-w-0 space-y-5 border-t border-border pt-5 lg:col-span-2 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-1">
            <div>
              <p class="section-label mb-2">Cash movement</p>
              <dl class="space-y-1 text-[13px]">
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Received</dt><dd class="tnum font-medium text-positive">{formatKpiValue(todaySummary.cashFlow.received, formatSignedMoneyCompact)}</dd></div>
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Spent</dt><dd class="tnum font-medium text-negative">{formatKpiValue(todaySummary.cashFlow.spent, formatSignedMoneyCompact)}</dd></div>
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg">Net movement</dt><dd class="tnum font-semibold {todaySummary.cashFlow.net.value === null ? 'text-fg-faint' : todaySummary.cashFlow.net.value >= 0 ? 'text-positive' : 'text-negative'}">{formatKpiValue(todaySummary.cashFlow.net, formatSignedMoneyCompact)}</dd></div>
              </dl>
            </div>
            <div>
              <p class="section-label mb-2">Economic effect</p>
              <dl class="space-y-1 text-[13px]">
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">True income</dt><dd class="tnum font-medium text-positive">{formatKpiValue(todaySummary.economicEffect.trueIncome, formatSignedMoneyCompact)}</dd></div>
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">True expenses</dt><dd class="tnum font-medium text-negative">{formatKpiValue(todaySummary.economicEffect.trueExpense, formatSignedMoneyCompact)}</dd></div>
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg">Economic net</dt><dd class="tnum font-semibold {todaySummary.economicEffect.net.value === null ? 'text-fg-faint' : todaySummary.economicEffect.net.value >= 0 ? 'text-positive' : 'text-negative'}">{formatKpiValue(todaySummary.economicEffect.net, formatSignedMoneyCompact)}</dd></div>
              </dl>
              <p class="mt-1.5 text-[11px] text-fg-faint">Conversions are excluded — they are movement, not earnings.</p>
            </div>
            <div>
              <p class="section-label mb-2">Also today</p>
              <dl class="space-y-1 text-[13px]">
                <div class="flex items-baseline justify-between gap-3">
                  <dt class="text-fg-muted">Travel profit <span class="text-[10px] uppercase text-fg-faint">est.</span></dt>
                  <dd class="tnum font-medium {todaySummary.travel.estimatedProfit.value === null ? 'text-fg-faint' : todaySummary.travel.estimatedProfit.value >= 0 ? 'text-positive' : 'text-negative'}">{formatKpiValue(todaySummary.travel.estimatedProfit, formatSignedMoneyCompact)}</dd>
                </div>
                <div class="flex items-baseline justify-between gap-3">
                  <dt class="text-fg-muted">Drug consumption <span class="text-[10px] uppercase text-fg-faint">est.</span></dt>
                  <dd class="tnum font-medium text-fg">{formatKpiValue(todaySummary.drugs.estimatedConsumptionValue)}</dd>
                </div>
                <div class="flex items-baseline justify-between gap-3">
                  <dt class="text-fg-muted">Value converted</dt>
                  <dd class="tnum font-medium text-fg-muted">{formatKpiValue(todaySummary.assetConversions.convertedIn, formatSignedMoneyCompact)}</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      {/if}
    </section>

    <!-- ── 5 · Recent activity ledger ── -->
    <section class="section-rule" aria-label="Recent activity">
      <div class="flex items-baseline justify-between gap-3">
        <h2 class="section-label">Recent activity</h2>
        <a href="/timeline" class="text-link shrink-0 text-xs font-medium">The ledger →</a>
      </div>
      {#if logsBlocked}
        <p class="mt-4 text-[13px] text-warning">{logsBlocked.title} — {logsBlocked.hint}</p>
      {:else if data.recentTimeline.length === 0}
        <p class="mt-4 text-[13px] text-fg-faint">No activity recorded in this range yet.</p>
      {:else}
        <ul class="mt-2 divide-y divide-border/70">
          {#each data.recentTimeline.slice(0, 6) as event (event.id)}
            <li class="grid grid-cols-[44px_1fr_auto] items-baseline gap-3 py-2.5">
              <span class="tnum text-[11px] text-fg-faint">{formatClock(event.occurredAt)}</span>
              <span class="min-w-0 truncate text-[13px] text-fg" title={event.title}>{event.title}</span>
              {#if event.amount !== null && event.amount !== undefined}
                <span class="tnum text-[13px] font-medium {event.amount >= 0 ? 'text-positive' : 'text-negative'}">
                  {event.amount >= 0 ? '+' : ''}{formatMoneyCompact(event.amount)}
                </span>
              {:else}
                <span class="text-[11px] text-fg-faint">{formatRelative(event.occurredAt)}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- ── 6 · Beyond money: quiet linked rows ── -->
    <section class="section-rule" aria-label="Beyond money">
      <h2 class="section-label">Beyond the wallet</h2>
      <div class="mt-3 grid grid-cols-1 gap-x-12 md:grid-cols-2">
        <!-- Crimes -->
        <a href="/crimes" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Crimes</span>
            <span class="block text-xs text-fg-faint">
              {#if logsBlocked}Unavailable with current permissions{:else if !data.crimes}No attempts in this range{:else}
                {data.crimes.attempts} attempts · {data.crimes.successRate !== null ? Math.round(data.crimes.successRate * 100) + "% success" : "rate —"}
              {/if}
            </span>
          </span>
          <span class="tnum shrink-0 text-[15px] font-semibold text-fg">{logsBlocked || !data.crimes || data.crimes.totalValue === null ? "" : formatMoneyCompact(data.crimes.totalValue)}</span>
        </a>
        <!-- Combat -->
        <a href="/combat" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Combat</span>
            <span class="block text-xs text-fg-faint">
              {#if attacksBlocked}Unavailable with current permissions{:else if !data.combat}No attacks in this range{:else}
                Outgoing attacks {data.combat.attacksMade} · Outgoing wins {data.combat.outgoingWins}
              {/if}
            </span>
          </span>
          <span class="shrink-0 text-[13px] text-fg-faint">{#if !attacksBlocked && data.combat}Successful defenses {data.combat.incomingDefended}{/if}</span>
        </a>
        <!-- Faction -->
        <a href="/faction" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Faction</span>
            <span class="block text-xs text-fg-faint">
              {#if !data.faction}No faction membership{:else}
                {data.faction.name ?? "—"} · {#if data.faction.lastWar}{data.faction.lastWar.result === "ongoing" ? "war ongoing" : "last war: " + data.faction.lastWar.result}{:else}no wars in range{/if}
              {/if}
            </span>
          </span>
          <span class="tnum shrink-0 text-[15px] font-semibold text-fg">{data.faction ? formatMoneyCompact(data.faction.myPayouts) : ""}</span>
        </a>
        <!-- Drugs -->
        <a href="/drugs" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Drug use</span>
            <span class="block text-xs text-fg-faint">
              {#if logsBlocked}Unavailable with current permissions{:else if data.drugsUsed.value === null || data.drugsUsed.value === undefined}No logged use in this range{:else}
                {data.drugsUsed.value} use{data.drugsUsed.value === 1 ? "" : "s"} in range · consumption value estimated
              {/if}
            </span>
          </span>
          <span class="shrink-0"><ConfidenceBadge meta={data?.confidence?.drugs} /></span>
        </a>
        <!-- Travel -->
        <a href="/travel" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Travel profit</span>
            <span class="block text-xs text-fg-faint">Estimated from catalog prices — never exact</span>
          </span>
          <span class="flex shrink-0 items-center gap-2">
            <ConfidenceBadge meta={data?.confidence?.travelProfit} />
            <span class="tnum text-[15px] font-semibold {logsBlocked ? 'text-fg' : (data.travelProfit.value ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">
              {logsBlocked ? "" : formatKpiValue(data.travelProfit)}
            </span>
          </span>
        </a>
        <!-- Timeline -->
        <a href="/timeline" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Timeline</span>
            <span class="block text-xs text-fg-faint">Every log and event, in order</span>
          </span>
          <span class="shrink-0 text-fg-faint" aria-hidden="true">→</span>
        </a>
      </div>
    </section>
  {/if}
</div>
