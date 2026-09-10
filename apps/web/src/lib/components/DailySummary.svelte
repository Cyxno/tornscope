<script lang="ts">
  import type { DailySummaryResponse, DailyHighlight } from "@tornscope/shared";
  import { formatDate, formatKpiValue, formatMoneyCompact, formatSignedMoney, formatSignedMoneyCompact } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { me } from "$lib/state.svelte";
  import { confidenceTitle } from "$lib/confidence";
  import { formatRelative } from "$lib/reltime";
  import ConfidenceBadge from "./ConfidenceBadge.svelte";

  /**
   * Daily Summary (v0.2): one trustworthy recap of a calendar day in the
   * user's timezone, mounted on the Today page — composed like a dated
   * report, not a card grid: serif date masthead, open hero delta, "why it
   * moved" as diverging bars, the three lenses as hairline-separated
   * columns, highlights as a ledger. The selected date lives in the URL
   * (?date=YYYY-MM-DD) so days can be shared and revisited; empty selection
   * = today. Every section renders through the shared confidence model —
   * unavailable is "—", a confirmed zero is $0, estimates are labeled.
   */

  let date = $state<string>("");
  let summary = $state<DailySummaryResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);
  let loadSeq = 0;

  const timeZone = $derived(me.data?.timezone || "UTC");
  const todayKey = $derived.by(() => {
    // The API owns day semantics; this mirror is only for the picker's max.
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return parts;
  });

  async function load() {
    const seq = ++loadSeq;
    loading = true;
    error = null;
    try {
      const res = await endpoints.dailySummary(date || undefined);
      // A newer load (the date changed again mid-flight) supersedes this
      // one — a stale response must never overwrite the selected day.
      if (seq !== loadSeq) return;
      summary = res;
    } catch (err) {
      if (seq !== loadSeq) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      summary = null;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  $effect(() => {
    void date;
    void reloadToken;
    void load();
  });

  function setDay(next: string) {
    date = next;
    syncUrl();
  }

  function shiftDay(delta: number) {
    const base = date || todayKey;
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    const next = d.toISOString().slice(0, 10);
    if (next > todayKey) return; // no future days
    setDay(next);
  }

  function syncUrl() {
    const url = new URL(window.location.href);
    if (date && date !== todayKey) url.searchParams.set("date", date);
    else url.searchParams.delete("date");
    window.history.replaceState({}, "", url);
  }

  // Initialize from the URL once.
  $effect(() => {
    const param = new URLSearchParams(window.location.search).get("date");
    if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) date = param;
  });

  const dayLabel = $derived.by(() => {
    const key = summary?.date ?? (date || todayKey);
    if (key === todayKey) return "Today";
    const d = new Date(`${key}T00:00:00Z`);
    const weekday = d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
    return `${weekday} ${formatDate(summary?.range.from ?? Math.floor(d.getTime() / 1000))}`;
  });

  /** Masthead split: the weekday is the display word; the date is metadata. */
  const mastheadWeekday = $derived.by(() => {
    const key = summary?.date ?? (date || todayKey);
    if (key === todayKey) return "Today";
    const d = new Date(`${key}T00:00:00Z`);
    return d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  });

  const displayDate = $derived(summary ? formatDate(summary.range.from) : "");

  /** Diverging driver bars scale to the day's largest absolute movement. */
  const driverMax = $derived(
    summary ? Math.max(1, ...(summary.netWorth.drivers ?? []).map((d) => Math.abs(d.magnitude ?? 0))) : 1
  );

  function highlightCopy(h: DailyHighlight): { text: string; hint?: string } {
    const amount = h.amount !== null ? formatSignedMoneyCompact(h.amount) : null;
    switch (h.kind) {
      case "large_cash_in":
        return { text: `Large cash inflow — ${h.label}`, hint: amount ?? undefined };
      case "large_cash_out":
        return { text: `Large cash outflow — ${h.label}`, hint: amount ?? undefined };
      case "asset_conversion":
        return { text: `Value converted — ${h.label}`, hint: amount ? `${amount} moved, not spent` : "cash moved into assets" };
      case "networth_move":
        return { text: "Net worth moved", hint: amount ?? undefined };
      case "travel_profit":
        return { text: `Travel — ${h.label}`, hint: amount !== null ? `${amount} estimated` : "estimated profit" };
      case "drug_use":
        return { text: `Consumption — ${h.label}`, hint: amount !== null ? `${amount} estimated value` : undefined };
      case "rehab":
        return { text: "Rehab visit", hint: amount !== null ? amount : "cost unavailable" };
      case "bank_transfer":
        return { text: `Internal transfer — ${h.label}`, hint: amount ?? undefined };
      case "combat":
        return { text: `Combat — ${h.label}`, hint: undefined };
      case "crime":
        return { text: `Crimes — ${h.label}`, hint: amount ?? undefined };
      case "account_event":
        return { text: h.label, hint: undefined };
      case "quiet_day":
        return { text: "A quiet day — nothing notable recorded." };
    }
  }

  const toneClass = { neutral: "text-fg", positive: "text-positive", negative: "text-negative", accent: "text-accent" };

  function netWorthWord(coverage: "full" | "partial" | "none"): string {
    return coverage === "full" ? "Net Worth Change" : coverage === "partial" ? "Tracked period change" : "Net Worth Change";
  }
</script>

<section aria-label="Daily summary" class="space-y-10">
  <!-- ── Masthead: the date IS the headline ── -->
  <div class="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
    <div class="min-w-0">
      <h2 class="font-display text-[30px] font-medium leading-[1.05] text-fg sm:text-[36px]">{mastheadWeekday}</h2>
      <p class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-fg-muted">
        <span class="tnum">{dayLabel === "Today" ? displayDate : displayDate}</span>
        {#if summary?.ongoingDay}
          <span class="chip chip-warning !py-0 !text-[9px]">day in progress</span>
        {/if}
        {#if summary}
          <ConfidenceBadge meta={summary.overallConfidence} tooltip={confidenceTitle(summary.overallConfidence, summary.overallConfidence.lastRefreshedAt ? `last refreshed ${formatRelative(summary.overallConfidence.lastRefreshedAt)}` : undefined)} />
        {/if}
      </p>
    </div>
    <div class="flex items-center gap-1.5">
      <button class="btn btn-sm !px-2.5" onclick={() => shiftDay(-1)} aria-label="Previous day">←</button>
      <input
        type="date"
        class="input !h-[30px] w-36 [color-scheme:dark]"
        max={todayKey}
        value={date}
        onchange={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          if (v) setDay(v);
        }}
        aria-label="Pick a day"
      />
      <button class="btn btn-sm !px-2.5" onclick={() => shiftDay(1)} disabled={!date || date >= todayKey} aria-label="Next day">→</button>
      {#if date && date !== todayKey}
        <button class="btn btn-sm" onclick={() => setDay("")}>Today</button>
      {/if}
    </div>
  </div>

  {#if loading && !summary}
    <div class="space-y-4" data-testid="skeleton" aria-busy="true">
      <div class="skeleton h-3 w-40"></div>
      <div class="skeleton h-12 w-64"></div>
      <div class="grid grid-cols-1 md:grid-cols-3">
        {#each Array(3) as _, i (i)}
          <div class="p-5 max-md:max-w-sm"><div class="skeleton h-3 w-20"></div><div class="skeleton mt-3 h-5 w-24"></div><div class="skeleton mt-2 h-5 w-16"></div></div>
        {/each}
      </div>
    </div>
  {:else if error}
    <div class="rounded-tile border border-negative/30 bg-negative/5 p-5 text-sm text-negative">
      {error}
      <button class="ml-3 underline" onclick={() => (reloadToken += 1)}>Retry</button>
    </div>
  {:else if summary}
    <!-- ── Hero: the official snapshot delta — a wealth movement, never profit ── -->
    <div class="section-rule">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p class="section-label">{netWorthWord(summary.netWorth.coverage)}</p>
        <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">exact · official Torn snapshots</span>
        <ConfidenceBadge meta={summary.netWorth.confidence} tooltip={confidenceTitle(summary.netWorth.confidence)} />
      </div>
      <p class="hero-num tnum mt-3 {summary.netWorth.delta === null ? 'text-fg-faint' : summary.netWorth.delta >= 0 ? 'text-positive' : 'text-negative'}">
        {summary.netWorth.delta === null ? "Insufficient history" : formatSignedMoneyCompact(summary.netWorth.delta)}
        {#if summary.netWorth.changePct !== null && summary.netWorth.delta !== null}
          <span class="ml-2 align-baseline text-[0.32em] font-medium text-fg-muted">{summary.netWorth.changePct >= 0 ? "+" : ""}{summary.netWorth.changePct.toFixed(2)}%</span>
        {/if}
      </p>
      {#if summary.netWorth.startAt !== null || summary.netWorth.endAt !== null}
        <p class="mt-2 text-xs text-fg-faint">
          snapshots {summary.netWorth.startAt !== null ? formatDate(summary.netWorth.startAt) : "—"} → {summary.netWorth.endAt !== null ? formatDate(summary.netWorth.endAt) : "—"}
          {#if summary.netWorth.coverage === "partial"} · covers the tracked portion only{/if}
          · includes price moves and asset movement, not a profit figure
        </p>
      {/if}

      <!-- Why it moved: diverging signed bars on the open canvas -->
      {#if (summary.netWorth.drivers ?? []).length > 0}
        <div class="mt-7">
          <p class="section-label">Why it moved — recorded movements, not causes</p>
          <ul class="mt-3 space-y-2.5">
            {#each summary.netWorth.drivers ?? [] as driver (driver.kind + driver.label)}
              {@const magnitude = driver.magnitude}
              <li class="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,1fr)_180px_auto]">
                <span class="min-w-0 truncate text-[13.5px] {driver.certainty === 'unexplained' ? 'text-warning' : 'text-fg-muted'}">
                  {driver.label}
                  {#if driver.certainty === "estimated"}<span class="ml-1 text-[10px] uppercase tracking-wide text-fg-faint">est.</span>{/if}
                  {#if driver.certainty === "unexplained"}<span class="ml-1 text-[10px] uppercase tracking-wide text-warning">unexplained</span>{/if}
                </span>
                <span class="hidden items-center sm:flex" aria-hidden="true">
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
                <span class="tnum text-right text-[13.5px] font-medium {magnitude === null ? 'text-fg-faint' : magnitude >= 0 ? 'text-positive' : 'text-negative'}">
                  {magnitude === null ? "—" : formatSignedMoneyCompact(magnitude)}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    <!-- ── Three lenses: hairline-separated columns on open canvas ── -->
    <div class="grid grid-cols-1 gap-x-10 gap-y-7 md:grid-cols-3 md:divide-x md:divide-border">
      <div class="md:pr-8">
        <div class="flex items-center justify-between gap-2">
          <p class="section-label">Cash flow</p>
          <ConfidenceBadge meta={summary.cashFlow.confidence} tooltip={confidenceTitle(summary.cashFlow.confidence)} />
        </div>
        <div class="mt-3 space-y-1.5 text-sm">
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Received</span><span class="tnum font-medium text-positive">{formatKpiValue(summary.cashFlow.received)}</span></p>
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Spent</span><span class="tnum font-medium text-negative">{formatKpiValue(summary.cashFlow.spent)}</span></p>
          <p class="flex items-baseline justify-between gap-3 border-t border-border pt-1.5"><span class="text-fg">Net movement</span><span class="tnum font-semibold text-fg">{formatKpiValue(summary.cashFlow.net, formatSignedMoneyCompact)}</span></p>
        </div>
        {#if summary.cashFlow.topInflow.length > 0 || summary.cashFlow.topOutflow.length > 0}
          <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
            {#if summary.cashFlow.topInflow[0]}Top in: {summary.cashFlow.topInflow[0].label}{/if}
            {#if summary.cashFlow.topInflow[0] && summary.cashFlow.topOutflow[0]} · {/if}
            {#if summary.cashFlow.topOutflow[0]}Top out: {summary.cashFlow.topOutflow[0].label}{/if}
          </p>
        {/if}
      </div>
      <div class="md:px-8">
        <div class="flex items-center justify-between gap-2">
          <p class="section-label">Economic effect</p>
          <ConfidenceBadge meta={summary.economicEffect.confidence} tooltip={confidenceTitle(summary.economicEffect.confidence)} />
        </div>
        <div class="mt-3 space-y-1.5 text-sm">
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">True income</span><span class="tnum font-medium text-positive">{formatKpiValue(summary.economicEffect.trueIncome)}</span></p>
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">True expenses</span><span class="tnum font-medium text-negative">{formatKpiValue(summary.economicEffect.trueExpense)}</span></p>
          <p class="flex items-baseline justify-between gap-3 border-t border-border pt-1.5"><span class="text-fg">Economic net</span><span class="tnum font-semibold text-fg">{formatKpiValue(summary.economicEffect.net, formatSignedMoneyCompact)}</span></p>
        </div>
        <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">Earned or lost value — conversions are excluded here.</p>
      </div>
      <div class="md:pl-8">
        <div class="flex items-center justify-between gap-2">
          <p class="section-label">Conversions</p>
          <ConfidenceBadge meta={summary.assetConversions.confidence} tooltip={confidenceTitle(summary.assetConversions.confidence)} />
        </div>
        <div class="mt-3 space-y-1.5 text-sm">
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Assets → cash</span><span class="tnum font-medium text-fg">{formatKpiValue(summary.assetConversions.convertedIn)}</span></p>
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Cash → assets</span><span class="tnum font-medium text-fg">{formatKpiValue(summary.assetConversions.convertedOut)}</span></p>
          {#if summary.assetConversions.bankTransfers > 0}
            <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Bank movements</span><span class="tnum text-fg-muted">{formatMoneyCompact(summary.assetConversions.bankTransfers)}</span></p>
          {/if}
        </div>
        <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">Value changing form — neither income nor spending.</p>
      </div>
    </div>

    <!-- ── Activity story: travel | drugs & rehab ── -->
    <div class="grid grid-cols-1 gap-x-10 gap-y-7 border-t border-border pt-7 md:grid-cols-2 md:divide-x md:divide-border">
      <div class="md:pr-8">
        <div class="flex items-center justify-between gap-2">
          <p class="section-label">Travel</p>
          <div class="flex items-center gap-2">
            <ConfidenceBadge meta={summary.travel.confidence} tooltip={confidenceTitle(summary.travel.confidence)} />
            <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-warning" title="Estimated value — based on current item market prices, not historical values">estimated</span>
          </div>
        </div>
        <p class="mt-3 flex flex-wrap items-baseline gap-x-3">
          <span class="tnum text-3xl font-semibold text-fg">{formatKpiValue(summary.travel.estimatedProfit)}</span>
          <span class="text-xs text-fg-faint">{summary.travel.trips} trip{summary.travel.trips === 1 ? "" : "s"} · est. profit</span>
        </p>
      </div>
      <div class="md:pl-8">
        <div class="flex items-center justify-between gap-2">
          <p class="section-label">Drugs &amp; rehab</p>
          <ConfidenceBadge meta={summary.drugs.confidence} tooltip={confidenceTitle(summary.drugs.confidence)} />
        </div>
        <div class="mt-3 space-y-1.5 text-sm">
          <p class="flex items-baseline justify-between gap-3">
            <span class="text-fg-muted">Estimated consumption value</span>
            <span class="tnum font-medium text-fg">{formatKpiValue(summary.drugs.estimatedConsumptionValue)}</span>
          </p>
          <p class="flex items-baseline justify-between gap-3">
            <span class="text-fg-muted">Xanax consumed</span>
            <span class="tnum text-fg" title={summary.drugs.xanax.confirmedFaction > 0 ? `${summary.drugs.xanax.confirmedFaction} faction-sponsored · personal cost $0` : undefined}>
              {summary.drugs.xanax.consumed}
              {#if summary.drugs.xanax.confirmedFaction > 0}<span class="ml-1 text-[11px] text-fg-faint">({summary.drugs.xanax.confirmedFaction} faction)</span>{/if}
            </span>
          </p>
          <p class="flex items-baseline justify-between gap-3">
            <span class="text-fg-muted">Rehab{summary.rehab.visits > 0 ? ` — ${summary.rehab.visits} visit${summary.rehab.visits === 1 ? "" : "s"}` : ""}</span>
            <span class="tnum text-fg">{formatKpiValue(summary.rehab.cost)}</span>
          </p>
        </div>
        {#if summary.drugs.xanax.openingInventoryUnknown > 0 || summary.drugs.xanax.unknown > 0}
          <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
            Funding not fully provable from the ledger (opening inventory or unrecorded stock) — counts stay explicit, never guessed.
          </p>
        {/if}
      </div>
    </div>

    <!-- ── What moved today: ledger rows, no panel ── -->
    <div class="section-rule">
      <p class="section-label">What moved — deterministic highlights, never causes</p>
      {#if summary.highlights.length === 0 || (summary.highlights.length === 1 && summary.highlights[0]?.kind === "quiet_day")}
        <p class="mt-3 text-sm text-fg-faint">A quiet day — nothing notable recorded.</p>
      {:else}
        <ul class="divide-y divide-border/70">
          {#each summary.highlights as h (h.kind + h.label + (h.occurredAt ?? ""))}
            {@const copy = highlightCopy(h)}
            <li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
              <span class="min-w-0 text-[13.5px] {toneClass[h.tone]}">{copy.text}</span>
              {#if copy.hint !== undefined}
                <span class="tnum text-[13.5px] font-medium text-fg-muted">{copy.hint}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>
