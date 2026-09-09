<script lang="ts">
  import type { DailySummaryResponse, DailyHighlight } from "@tornscope/shared";
  import { formatDate, formatKpiValue, formatMoneyCompact, formatSignedMoney } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { me } from "$lib/state.svelte";
  import { confidenceTitle } from "$lib/confidence";
  import { formatRelative } from "$lib/reltime";
  import ConfidenceBadge from "./ConfidenceBadge.svelte";
  import Panel from "./Panel.svelte";

  /**
   * Daily Summary (v0.2): one trustworthy recap of a calendar day in the
   * user's timezone, mounted on the Today page. The selected date lives in
   * the URL (?date=YYYY-MM-DD) so days can be shared and revisited; empty
   * selection = today. Every section renders through the shared confidence
   * model — unavailable is "—", a confirmed zero is $0, estimates are labeled.
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

  const displayDate = $derived(summary ? formatDate(summary.range.from) : "");

  function highlightCopy(h: DailyHighlight): { text: string; hint?: string } {
    const amount = h.amount !== null ? (h.amount >= 0 ? `+${formatMoneyCompact(h.amount)}` : `-${formatMoneyCompact(-h.amount)}`) : null;
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
        return { text: `Travel — ${h.label}`, hint: amount !== null ? `${amount} estimated` : "estimated" };
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

<section aria-label="Daily summary" class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="font-display text-2xl font-medium text-fg">{dayLabel}</h2>
      <span class="text-xs text-fg-faint">{displayDate}{summary?.ongoingDay ? " · day in progress" : ""}</span>
      {#if summary}
        <ConfidenceBadge meta={summary.overallConfidence} tooltip={confidenceTitle(summary.overallConfidence, summary.overallConfidence.lastRefreshedAt ? `last refreshed ${formatRelative(summary.overallConfidence.lastRefreshedAt)}` : undefined)} />
      {/if}
    </div>
    <div class="flex items-center gap-1.5">
      <button
        class="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-30"
        onclick={() => shiftDay(-1)}
        aria-label="Previous day"
      >←</button>
      <input
        type="date"
        class="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg-muted [color-scheme:dark]"
        max={todayKey}
        value={date}
        onchange={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          if (v) setDay(v);
        }}
        aria-label="Pick a day"
      />
      <button
        class="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-30"
        onclick={() => shiftDay(1)}
        disabled={!date || date >= todayKey}
        aria-label="Next day"
      >→</button>
      {#if date && date !== todayKey}
        <button
          class="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
          onclick={() => setDay("")}
        >Today</button>
      {/if}
    </div>
  </div>

  {#if loading && !summary}
    <div class="animate-pulse rounded-2xl border border-border bg-surface p-8 text-sm text-fg-faint">Loading the day…</div>
  {:else if error}
    <div class="rounded-2xl border border-negative/30 bg-negative/5 p-5 text-sm text-negative">
      {error}
      <button class="ml-3 underline" onclick={() => (reloadToken += 1)}>Retry</button>
    </div>
  {:else if summary}
    <!-- Hero: the official snapshot delta — a wealth movement, never profit -->
    <div class="rounded-2xl border border-border bg-surface px-6 py-6 shadow-panel sm:px-8">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-faint">{netWorthWord(summary.netWorth.coverage)}</p>
        <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">exact · official Torn snapshots</span>
        <ConfidenceBadge meta={summary.netWorth.confidence} tooltip={confidenceTitle(summary.netWorth.confidence)} />
      </div>
      <p class="mt-2 flex flex-wrap items-baseline gap-x-3">
        <span class="tnum font-display text-4xl font-semibold {summary.netWorth.delta === null ? 'text-fg-faint' : summary.netWorth.delta >= 0 ? 'text-positive' : 'text-negative'}">
          {summary.netWorth.delta === null ? "Insufficient history" : formatSignedMoney(summary.netWorth.delta)}
        </span>
        {#if summary.netWorth.changePct !== null}
          <span class="text-sm text-fg-muted">{summary.netWorth.changePct >= 0 ? "+" : ""}{summary.netWorth.changePct.toFixed(2)}%</span>
        {/if}
      </p>
      {#if summary.netWorth.startAt !== null || summary.netWorth.endAt !== null}
        <p class="mt-1 text-xs text-fg-faint">
          snapshots {summary.netWorth.startAt !== null ? formatDate(summary.netWorth.startAt) : "—"} → {summary.netWorth.endAt !== null ? formatDate(summary.netWorth.endAt) : "—"}
          {#if summary.netWorth.coverage === "partial"} · covers the tracked portion only{/if}
          · includes price moves and asset movement, not a profit figure
        </p>
      {/if}
      {#if summary.netWorth.drivers && summary.netWorth.drivers.length > 0}
        <div class="mt-4 space-y-1.5 border-t border-border pt-3">
          <p class="text-[10px] font-medium uppercase tracking-[0.14em] text-fg-faint">Likely contributors — recorded movements, not causes</p>
          <ul class="space-y-1 text-[13px]">
            {#each summary.netWorth.drivers as driver (driver.kind + driver.label)}
              <li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <span class="text-fg-muted">
                  {driver.label}
                  {#if driver.certainty === "estimated"}<span class="ml-1 text-[10px] uppercase tracking-wide text-fg-faint">est.</span>{/if}
                  {#if driver.certainty === "unexplained"}<span class="ml-1 text-[10px] uppercase tracking-wide text-warning">unexplained</span>{/if}
                </span>
                <span class="tnum {driver.magnitude === null ? 'text-fg-faint' : driver.magnitude >= 0 ? 'text-positive' : 'text-negative'}">
                  {driver.magnitude === null ? "—" : formatSignedMoney(driver.magnitude)}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>

    <!-- Three lenses: cash movement | economic effect | conversions -->
    <div class="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-3">
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Cash flow</p>
          <ConfidenceBadge meta={summary.cashFlow.confidence} tooltip={confidenceTitle(summary.cashFlow.confidence)} />
        </div>
        <div class="mt-3 space-y-1.5 text-sm">
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Received</span><span class="tnum font-medium text-positive">{formatKpiValue(summary.cashFlow.received)}</span></p>
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Spent</span><span class="tnum font-medium text-negative">{formatKpiValue(summary.cashFlow.spent)}</span></p>
          <p class="flex items-baseline justify-between gap-3 border-t border-border pt-1.5"><span class="text-fg-muted">Net movement</span><span class="tnum font-semibold text-fg">{formatKpiValue(summary.cashFlow.net, formatSignedMoney)}</span></p>
        </div>
        {#if summary.cashFlow.topInflow.length > 0 || summary.cashFlow.topOutflow.length > 0}
          <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
            {#if summary.cashFlow.topInflow[0]}Top in: {summary.cashFlow.topInflow[0].label}{/if}
            {#if summary.cashFlow.topInflow[0] && summary.cashFlow.topOutflow[0]} · {/if}
            {#if summary.cashFlow.topOutflow[0]}Top out: {summary.cashFlow.topOutflow[0].label}{/if}
          </p>
        {/if}
      </div>
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Economic effect</p>
          <ConfidenceBadge meta={summary.economicEffect.confidence} tooltip={confidenceTitle(summary.economicEffect.confidence)} />
        </div>
        <div class="mt-3 space-y-1.5 text-sm">
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">True income</span><span class="tnum font-medium text-positive">{formatKpiValue(summary.economicEffect.trueIncome)}</span></p>
          <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">True expenses</span><span class="tnum font-medium text-negative">{formatKpiValue(summary.economicEffect.trueExpense)}</span></p>
          <p class="flex items-baseline justify-between gap-3 border-t border-border pt-1.5"><span class="text-fg-muted">Economic net</span><span class="tnum font-semibold text-fg">{formatKpiValue(summary.economicEffect.net, formatSignedMoney)}</span></p>
        </div>
        <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">Earned or lost value — conversions are excluded here.</p>
      </div>
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Conversions</p>
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

    <!-- Travel | Drugs & rehab -->
    <div class="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-2">
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Travel</p>
          <div class="flex items-center gap-2">
            <ConfidenceBadge meta={summary.travel.confidence} tooltip={confidenceTitle(summary.travel.confidence)} />
            <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-warning" title="Estimated value — based on current item market prices, not historical values">estimated</span>
          </div>
        </div>
        <p class="mt-3 flex flex-wrap items-baseline gap-x-3">
          <span class="tnum text-2xl font-semibold text-fg">{formatKpiValue(summary.travel.estimatedProfit)}</span>
          <span class="text-xs text-fg-faint">{summary.travel.trips} trip{summary.travel.trips === 1 ? "" : "s"} · est. profit</span>
        </p>
      </div>
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Drugs &amp; rehab</p>
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

    <!-- What moved today -->
    <Panel title="What moved today" caption="Deterministic highlights — recorded movements and catalog estimates, never causes" flush>
      {#if summary.highlights.length === 0 || (summary.highlights.length === 1 && summary.highlights[0]?.kind === "quiet_day")}
        <p class="px-5 py-6 text-sm text-fg-faint">A quiet day — nothing notable recorded.</p>
      {:else}
        <ul class="divide-y divide-border">
          {#each summary.highlights as h (h.kind + h.label + (h.occurredAt ?? ""))}
            {@const copy = highlightCopy(h)}
            <li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-3">
              <span class="min-w-0 text-[13px] {toneClass[h.tone]}">{copy.text}</span>
              {#if copy.hint !== undefined}
                <span class="tnum text-[13px] font-medium text-fg-muted">{copy.hint}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </Panel>
  {/if}
</section>
