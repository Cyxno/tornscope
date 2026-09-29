<script lang="ts">
  import { goto } from "$app/navigation";
  import type { DashboardResponse, TodayResponse, DailySummaryResponse, CommandCenterResponse, GoalsResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatNumberCompact, formatSignedNumberCompact, formatKpiValue, periodLabel, formatSignedMoneyCompact } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import LiveNow from "$lib/components/LiveNow.svelte";
  import CommandCenter from "$lib/components/CommandCenter.svelte";
  import GoalsMini from "$lib/components/GoalsMini.svelte";
  import { dateRange, me, prefs, overviewSectionOrder, setDashboardMode, DASHBOARD_MODES } from "$lib/state.svelte";
  import { clientPermissionMessage } from "$lib/capabilities";
  import { confidenceTitle } from "$lib/confidence";
  import { formatDateInZone, formatRelative, greetingForHour } from "$lib/reltime";
  import { explainWealthStory } from "@tornscope/shared";
  import ConfidenceBadge from "$lib/components/ConfidenceBadge.svelte";
  import Chart from "$lib/components/Chart.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { C, GRID, timeAxis, valueAxis, moneyValueAxis, moneyTooltipValue, dayLabel, hourLabel, axisTimeTooltip, tealArea, MOTION } from "$lib/charts";
  import * as td from "$lib/time-display.svelte.js";

  /**
   * Overview — "my live Torn control panel" (dashboard-first redesign, 2.x).
   *
   * Zone A · COCKPIT (top, one grid): the dominant LIVE STATUS bars +
   * cooldown tiles + active states (LiveNow), with Needs Attention (capped
   * at 3) and Goals mini beside them on wide screens. Everything here is
   * NOW: state, timers, actionable attention.
   * Zone B · FINANCIAL SNAPSHOT: net worth + the compact money strip —
   * figures, no chart.
   * Zone C · ANALYTICS: the net-worth trend chart, today's story, recent
   * activity and the beyond-money rows — data over urgency, lower on the
   * page. Focus ordering (prefs.focus) reorders prominence WITHIN this zone.
   */

  let data = $state<DashboardResponse | null>(null);
  let today = $state<TodayResponse | null>(null);
  let todaySummary = $state<DailySummaryResponse | null>(null);
  let myOcs = $state<Array<{ name: string; tier: number | null; status: string; readyAt: number | null; myParticipation: boolean }> | null>(null);
  let commandCenter = $state<CommandCenterResponse | null>(null);
  let goals = $state<GoalsResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  // DB-backed panels render as soon as the dashboard lands. The live-status
  // call can wait on upstream Torn (first-ever load with no persisted
  // last-known copy) — it fills in independently and must never hold the
  // whole page hostage (real-user cold-load finding).
  async function load() {
    loading = true;
    error = null;
    void endpoints
      .today()
      .then((res) => (today = res))
      .catch(() => undefined);
    // The Command Center feed fills in independently — a slow or failed
    // attention feed must never hold the dashboard hostage.
    void endpoints
      .commandCenter()
      .then((res) => (commandCenter = res))
      .catch(() => undefined);
    // Goals mini likewise: a local DB read, never blocking the dashboard.
    void endpoints
      .goals()
      .then((res) => (goals = res))
      .catch(() => undefined);
    try {
      const [dash, summaryRes, ocsRes] = await Promise.all([
        endpoints.dashboard({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to }),
        endpoints.dailySummary().catch(() => null),
        endpoints.factionOcs({ preset: "30d" }).catch(() => null),
      ]);
      data = dash;
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

  // Greeting follows the DISPLAY zone clock — a UTC host/browser must never
  // greet "Good morning" at the user's local noon (V1.0 sanity pass).
  const greeting = $derived(greetingForHour(td.displayHour(Date.now())));

  // The masthead names the PROFILE-timezone day the Today summary covers —
  // the same day semantics as the summary itself (display zone may differ
  // near midnight; the day key is the profile's, the summary is explicit).
  const profileZone = $derived(me.data?.timezone || "UTC");
  const todayHeading = $derived.by(() => {
    if (todaySummary) return formatDateInZone(todaySummary.range.from, profileZone);
    return formatDateInZone(Math.floor(Date.now() / 1000), profileZone);
  });

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
      tooltip: axisTimeTooltip(data.networthSeries.map((p) => p.t), moneyTooltipValue()),
      grid: { ...GRID, top: 8, bottom: 0 },
      xAxis: timeAxis(data.networthSeries.map((p) => (interval === "hour" ? hourLabel(p.t) : dayLabel(p.t)))),
      yAxis: { ...moneyValueAxis(), splitNumber: 4 },
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

  /* Wealth story (V1.0 financial semantics): the one hedged plain-language
     narrative under the trend chart — only when classified asset purchases
     defensibly dominate the wallet outflow. Explains the acceptance case:
     wealth +$5m while the wallet moved −$8.6m must never read as a loss. */
  const wealthStory = $derived(
    data
      ? explainWealthStory({
          netWorthChange: data.networthChange.value,
          trueIncome: data.financial.trueIncome,
          trueCosts: data.financial.trueExpense,
          movedIntoAssets: data.financial.assetPurchases,
          movedBackToCash: data.financial.assetSales,
          walletOutflow: data.financial.cashOutflow.value,
          walletMovement: data.wallet.walletInflow - data.wallet.walletOutflow,
        })
      : null
  );
  const driverMax = $derived(Math.max(1, ...drivers.map((d) => Math.abs(d.magnitude === null ? 0 : d.magnitude))));

  // Permission gates: never a fake zero when the key cannot see the data.
  const caps = $derived(me.data?.capabilities ?? null);
  const logsBlocked = $derived(clientPermissionMessage(caps, "money_cash_flow"));
  const attacksBlocked = $derived(clientPermissionMessage(caps, "combat_history"));
  const networthBlocked = $derived(clientPermissionMessage(caps, "networth_history"));
</script>

<svelte:head><title>Overview · TornScope</title></svelte:head>

<div class="space-y-8">
  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load Overview" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    <!-- Focus areas reorder ANALYTICS prominence (personalization): the
         cockpit above is always live-first; this order shapes the lower
         data zone only. -->
    {@const order = overviewSectionOrder(prefs.focus)}
    <!-- ── Masthead: greeting + range, data health quiet at the right ── -->
    <header class="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div class="min-w-0">
        <p class="section-label">Overview</p>
        <h1 class="font-display mt-1.5 text-[28px] font-medium leading-[1.1] text-fg sm:text-[34px]">
          {greeting}{today?.player.name ? `, ${today.player.name}` : ""}.
        </h1>
        <p class="mt-1 flex flex-wrap items-center gap-x-2 text-[12.5px] text-fg-muted">
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
        <div class="flex items-center rounded-full border border-border bg-surface p-0.5" role="group" aria-label="Presentation mode">
          {#each DASHBOARD_MODES as m (m.value)}
            <button
              class="rounded-full px-3 py-1 text-xs font-medium transition-colors {prefs.mode === m.value ? 'bg-accent-strong text-bg' : 'text-fg-muted hover:text-fg'}"
              aria-pressed={prefs.mode === m.value}
              onclick={() => setDashboardMode(m.value)}
            >
              {m.label}
            </button>
          {/each}
        </div>
      </div>
    </header>

    <!-- ══ ZONE A · COCKPIT — live state, timers, attention, goals ══ -->
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
      <div class="min-w-0">
        <LiveNow today={today} ocs={myOcs} onOpenToday={() => void goto("/today")} />
      </div>
      <div class="min-w-0 space-y-4">
        {#if commandCenter}
          <CommandCenter items={commandCenter.items} maxItems={3} />
        {/if}
        <GoalsMini goals={goals} />
      </div>
    </div>

    <!-- ══ ZONE B · FINANCIAL SNAPSHOT — figures, no chart ══ -->
    <section class="section-rule" aria-label="Financial snapshot">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="section-label">Net worth</span>
          <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">exact · official Torn figure</span>
          <ConfidenceBadge meta={data.confidence?.networth} tooltip={confidenceTitle(data.confidence?.networth, data.lastSyncAt !== null ? `last sync ${formatRelative(data.lastSyncAt)}` : undefined)} />
        </div>
        <a href="/money" class="text-link shrink-0 text-xs font-medium">View economy →</a>
      </div>

      <div class="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-2">
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
              · {data.financial.netWorthMeasuredFrom !== null ? td.displayDate(data.financial.netWorthMeasuredFrom) : "—"} → {data.financial.netWorthMeasuredTo !== null ? td.displayDate(data.financial.netWorthMeasuredTo) : "now"}{data.networthCoverage === "partial" ? " · partial coverage" : ""}
            </span>
          {/if}
        </p>
        {#if data.extendedWealth.value !== null}
          <p class="text-xs text-fg-faint" title="Official Torn net worth plus wealth Torn does not count in that figure.">
            Extended <span class="tnum font-medium text-fg-muted">{formatMoneyCompact(data.extendedWealth.value)}</span>
          </p>
        {/if}
      </div>

      <!-- Open hairline strip. Financial hierarchy: WEALTH (hero above) →
           training/liquidity or economic lenses. Red/green are reserved for
           economic meaning; full wallet accounting lives in Economy. -->
      <dl class="mt-5 grid grid-cols-2 gap-y-4 md:grid-cols-4 md:divide-x md:divide-border">
        {#if prefs.mode === "simple"}
          <div class="md:pr-6">
            <dt class="text-[11px] font-medium text-fg-faint" title="Battlestats gained today from hourly Torn snapshots — not a profit figure">Battlestats today</dt>
            <dd class="tnum mt-1 text-[20px] font-semibold {(todaySummary?.progression?.battlestatGain.value ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">
              {todaySummary?.progression?.battlestatGain.value != null ? formatSignedNumberCompact(todaySummary.progression.battlestatGain.value) : '—'}
            </dd>
          </div>
          <div class="md:px-6" title="Inferred training sessions from bar history — Xanax uses are exact from your drug log">
            <dt class="text-[11px] font-medium text-fg-faint">Training today</dt>
            <dd class="tnum mt-1 text-[20px] font-semibold text-fg">
              {todaySummary?.progression ? `${todaySummary.progression.sessions} session${todaySummary.progression.sessions === 1 ? '' : 's'}` : '—'}
            </dd>
            <dd class="mt-0.5 text-[11px] text-fg-faint">
              {#if (todaySummary?.progression?.energyTrained.value ?? null) !== null}~{formatNumberCompact(todaySummary?.progression?.energyTrained.value)} E{/if}{#if (todaySummary?.drugs.xanax.consumed ?? 0) > 0} · {todaySummary?.drugs.xanax.consumed} Xanax{/if}
            </dd>
          </div>
          <div class="md:px-6">
            <dt class="flex items-center gap-2 text-[11px] font-medium text-fg-faint">
              Cash on hand <ConfidenceBadge meta={data.confidence?.networth} />
            </dt>
            <dd class="tnum mt-1 text-[20px] font-semibold text-fg">{formatKpiValue(data.cash)}</dd>
            <dd class="mt-0.5 text-[11px] text-fg-faint" title="Liquid cash. In Torn, holding little cash is intentional and healthy — wallet cash is exposed to mugging, so most wealth lives in banks, stocks and items.">liquidity — low cash is normal</dd>
          </div>
        {:else}
          <div class="md:pr-6">
            <dt class="text-[11px] font-medium text-fg-faint" title="Earned or received-for-good money — raises economic value directly. Asset sales are NOT income (they are conversion).">{period} true income</dt>
            <dd class="tnum mt-1 text-[20px] font-semibold text-positive">{formatMoneyCompact(data.financial.trueIncome)}</dd>
          </div>
          <div class="md:px-6">
            <dt class="text-[11px] font-medium text-fg-faint" title="Value consumed or lost for good. Asset purchases are NOT costs — the value is still owned in another form.">{period} true costs</dt>
            <dd class="tnum mt-1 text-[20px] font-semibold text-negative">{formatMoneyCompact(data.financial.trueExpense)}</dd>
          </div>
          <div class="md:px-6">
            <dt class="text-[11px] font-medium text-fg-faint" title="Cash spent acquiring assets you still own, and cash received selling them — a change of form in both directions; neutral, not P&amp;L.">{period} asset movement</dt>
            <dd class="tnum mt-1 text-[20px] font-semibold text-fg">
              {formatMoneyCompact(data.financial.assetPurchases)} in · {formatMoneyCompact(data.financial.assetSales)} back
            </dd>
          </div>
          <div class="md:pl-6">
            <dt class="flex items-center gap-2 text-[11px] font-medium text-fg-faint">
              Cash on hand <ConfidenceBadge meta={data.confidence?.networth} />
            </dt>
            <dd class="tnum mt-1 text-[20px] font-semibold text-fg">{formatKpiValue(data.cash)}</dd>
            <dd class="mt-0.5 text-[11px] text-fg-faint" title="Liquid cash. In Torn, holding little cash is intentional and healthy — wallet cash is exposed to mugging, so most wealth lives in banks, stocks and items.">liquidity — low cash is normal</dd>
          </div>
        {/if}
      </dl>
    </section>

    <!-- ══ ZONE C · ANALYTICS — trends and history, below the cockpit ══ -->
    <div class="flex flex-col gap-8">
    <!-- ── Net-worth trend: the chart + the hedged narrative ── -->
    <section class="section-rule" aria-label="Net worth trend" style="order: {order.networth};">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 class="section-label">Net worth trend</h2>
        <a href="/money" class="text-link shrink-0 text-xs font-medium">Full economy →</a>
      </div>

      <div class="mt-3">
        {#if networthBlocked}
          <StateMessage state="permission" compact title={networthBlocked.title} hint={networthBlocked.hint} />
        {:else if !networthOption}
          <div class="flex h-40 items-center justify-center text-[13px] text-fg-faint">
            Snapshots appear as the worker runs — no net-worth history in this range yet.
          </div>
        {:else}
          <Chart option={networthOption} height={260} />
        {/if}
      </div>

      {#if wealthStory?.headline}
        <p class="mt-3 text-[13px] leading-relaxed text-fg-muted" title="Derived from classified money events (earned vs asset conversion) — hedged on purpose; the exact split lives in the Economy reconciliation.">
          {wealthStory.headline}
        </p>
      {/if}
      {#if prefs.mode !== "simple" && data.wallet.coverage !== "unavailable"}
        <p class="mt-2 text-[11px] text-fg-faint" title="Net cash movement is wallet arithmetic (cash in minus cash out). In Torn most of it is money changing form — not profit or loss.">
          Net cash movement {formatSignedMoneyCompact(data.wallet.walletInflow - data.wallet.walletOutflow)} — transport, not profit/loss{data.wallet.unreconciled !== null ? ` · reconciliation ${formatSignedMoneyCompact(data.wallet.unreconciled)}` : ""}
        </p>
      {/if}
    </section>

    <!-- ── Today story: the day as a signed ledger ── -->
    <section class="section-rule" aria-label="Today's story" style="order: {order.today};">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 class="section-label">Today — {todayHeading}</h2>
          {#if todaySummary?.ongoingDay}<span class="chip chip-warning !py-0 !text-[9px]">day in progress</span>{/if}
          {#if todaySummary}
            <ConfidenceBadge meta={todaySummary.overallConfidence} tooltip={confidenceTitle(todaySummary.overallConfidence)} />
          {/if}
        </div>
        <a href="/today" class="text-link shrink-0 text-xs font-medium">The full day →</a>
      </div>

      {#if !todaySummary}
        <p class="mt-4 text-[13px] text-fg-faint">The day's recap appears after the first sync — see <a href="/sync" class="text-link">Sync status</a>.</p>
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
              Category movements — they add up to the change above{#if todaySummary.netWorth.coverage === "partial"} · covers the tracked portion only{/if}.
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
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Inflow</dt><dd class="tnum font-medium text-fg">{formatKpiValue(todaySummary.cashFlow.received, formatSignedMoneyCompact)}</dd></div>
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">Outflow</dt><dd class="tnum font-medium text-fg">{formatKpiValue(todaySummary.cashFlow.spent, formatMoneyCompact)}</dd></div>
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg">Net movement</dt><dd class="tnum font-semibold text-fg">{formatKpiValue(todaySummary.cashFlow.net, formatSignedMoneyCompact)}</dd></div>
              </dl>
              <p class="mt-1.5 text-[11px] text-fg-faint">Movement only — not profit/loss.</p>
            </div>
            <div>
              <p class="section-label mb-2">Economic effect</p>
              <dl class="space-y-1 text-[13px]">
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">True income</dt><dd class="tnum font-medium text-positive">{formatKpiValue(todaySummary.economicEffect.trueIncome, formatSignedMoneyCompact)}</dd></div>
                <div class="flex items-baseline justify-between gap-3"><dt class="text-fg-muted">True expenses</dt><dd class="tnum font-medium text-negative">{formatKpiValue(todaySummary.economicEffect.trueExpense, formatMoneyCompact)}</dd></div>
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

    <!-- ── Recent activity ledger ── -->
    <section class="section-rule" aria-label="Recent activity" style="order: {order.activity};">
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
              <span class="tnum text-[11px] text-fg-faint">{td.displayTime(event.occurredAt)}</span>
              <span class="min-w-0 truncate text-[13px] text-fg" title={event.title}>{event.title}</span>
              {#if event.amount !== null && event.amount !== undefined}
                <!-- Neutral: a mixed feed (income, purchases, transfers) must not
                     color by sign — sign stays in the text, not the sentiment. -->
                <span class="tnum text-[13px] font-medium text-fg">
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

    <!-- ── Beyond money: quiet linked rows ── -->
    <section class="section-rule" aria-label="Beyond money" style="order: {order.beyond};">
      <h2 class="section-label">Beyond the wallet</h2>
      <div class="mt-3 grid grid-cols-1 gap-x-12 md:grid-cols-2">
        <!-- Crimes -->
        <a href="/crimes" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Crimes</span>
            <span class="block text-xs text-fg-faint">
              {#if logsBlocked}Unavailable with current permissions{:else if !data.crimes}No attempts in this range{:else}
                {data.crimes.attempts} attempt{data.crimes.attempts === 1 ? "" : "s"} · {data.crimes.successRate !== null ? Math.round(data.crimes.successRate * 100) + "% success" : "rate —"}
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
        <!-- Progression: one concise glimpse (full analysis on /progression) -->
        <a href="/progression" class="group flex items-baseline justify-between gap-4 border-b border-border/60 py-3 transition-colors hover:bg-surface/40">
          <span class="min-w-0">
            <span class="block text-[13px] font-medium text-fg group-hover:text-accent">Training</span>
            <span class="block text-xs text-fg-faint">
              {#if data.progression.battlestatGain.value === null}No stat history in this range{:else}
                +{formatNumberCompact(data.progression.battlestatGain.value)} battlestats in range
                {#if data.progression.energyTrained.value !== null}· {formatNumberCompact(data.progression.energyTrained.value)} energy trained{/if}
              {/if}
            </span>
          </span>
          <span class="shrink-0 text-[13px] text-fg-faint">estimated · inferred</span>
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
            <span class="tnum text-[15px] font-semibold {logsBlocked ? 'text-fg' : (data.travelProfit.value === null || data.travelProfit.value >= 0) ? 'text-positive' : 'text-negative'}">
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
    </div>
  {/if}
</div>
