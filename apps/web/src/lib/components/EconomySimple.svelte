<script lang="ts">
  import type { EconomySummaryResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoneyCompact, formatDate } from "@tornscope/shared";
  import { setDashboardMode } from "$lib/state.svelte";
  import ConfidenceBadge from "./ConfidenceBadge.svelte";

  /**
   * Economy — SIMPLE presentation (curated interpretation, not reduced
   * Advanced).
   *
   * Answers, in order: "Am I richer or poorer?", "What mainly changed?",
   * "How much of it was real income vs costs?", and — when part of the move
   * can't be attributed — says so plainly and points to the detail below.
   *
   * Deliberately OMITTED here (each is one more lens on the same events and
   * lives in Advanced or the disclosure): the asset-shifts view (Advanced
   * conversions lens), the notable-movements list (Advanced rail), the
   * biggest-cost breakdown (Advanced economic-effect lens), and any wallet
   * throughput headline (Advanced editorial + cash lens). Uncertainty stays
   * honest but neutral — an unattributed residual is not a warning.
   */

  let { economy, period }: { economy: EconomySummaryResponse; period: string } = $props();

  const nw = $derived(economy.networth);
  const effect = $derived(economy.economicEffect);
  // Main drivers: the category moves that carried the change, largest first.
  // Zero-change rows carry no information and are omitted.
  const drivers = $derived.by(() =>
    [...nw.byCategory].filter((c) => c.change !== 0).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 4)
  );
  // The net-worth-vs-economic-effect gap: net worth includes asset (price)
  // moves and conversions; economic effect does not. Never force a balance.
  const unexplained = $derived(economy.explanation.netWorthUnexplained);
  const unexplainedMaterial = $derived(
    unexplained !== null && Math.abs(unexplained) > Math.max(1_000, Math.abs(nw.change.value ?? 0) * 0.02)
  );
</script>

<section aria-label="Economy summary" class="space-y-9">
  <!-- ── Outcome: the official wealth result ── -->
  <div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p class="section-label">Net worth change</p>
      <span class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">exact · official Torn snapshots</span>
      <ConfidenceBadge meta={economy.confidence.networth} />
    </div>
    <p class="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span
        class="hero-num tnum {nw.change.value === null
          ? 'text-fg-faint'
          : nw.change.value >= 0
            ? 'text-positive'
            : 'text-negative'}"
      >
        {nw.change.value === null ? "Insufficient history" : formatSignedMoneyCompact(nw.change.value)}
      </span>
      {#if nw.changePct !== null}
        <span class="tnum text-lg text-fg-muted">{nw.changePct >= 0 ? "+" : ""}{nw.changePct.toFixed(2)}%</span>
      {/if}
      <span class="text-[13px] text-fg-faint" title="How much Torn's official total value changed. Includes price moves and money moving between assets — not a profit figure.">
        {period} · snapshots {nw.baselineAt !== null ? formatDate(nw.baselineAt) : "—"} → {nw.currentAt !== null ? formatDate(nw.currentAt) : "now"}{nw.coverage === "partial" ? " · covers the tracked portion only" : ""}
      </span>
    </p>
  </div>

  <!-- ── Main drivers: what carried the change ── -->
  {#if drivers.length > 0}
    <div class="section-rule pt-7">
      <p class="section-label">Main drivers</p>
      <p class="mt-1 text-[11px] text-fg-faint">Official category movements, largest first — non-cash moves include price changes.</p>
      <ul class="mt-4 space-y-2.5">
        {#each drivers as c (c.key)}
          <li class="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
            <span class="text-[13.5px] text-fg-muted">
              {c.label}{#if c.key !== "cash"}<span class="ml-1.5 text-[10px] uppercase tracking-wide text-fg-faint">incl. price moves</span>{/if}
            </span>
            <span class="tnum text-[13.5px] font-medium {c.change >= 0 ? "text-positive" : "text-negative"}">{formatSignedMoneyCompact(c.change)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {:else if nw.byCategory.length > 0}
    <div class="section-rule pt-7">
      <p class="section-label">Main drivers</p>
      <p class="mt-4 text-[13px] text-fg-faint">Nothing moved this period — every category is flat.</p>
    </div>
  {/if}

  <!-- ── Known income & costs: real economics, conversions excluded ── -->
  <div class="section-rule pt-7">
    <div class="flex items-center justify-between gap-2">
      <p class="section-label">Known income &amp; costs</p>
      <ConfidenceBadge meta={effect.confidence} />
    </div>
    <p class="mt-1 text-[11px] text-fg-faint" title="Known income minus true costs. Moving money between assets does not count.">
      Known income minus true costs — moving money between assets does not count.
    </p>
    <div class="mt-4 space-y-2 text-sm">
      <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Income</span><span class="tnum font-medium text-positive">+{formatMoneyCompact(effect.income.value)}</span></p>
      <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Costs</span><span class="tnum font-medium text-negative">−{formatMoneyCompact(effect.expenses.value)}</span></p>
      <p class="flex items-baseline justify-between gap-3 border-t border-border pt-2"><span class="text-fg">Net</span><span class="tnum text-[15px] font-semibold {(effect.net.value ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">{effect.net.value === null ? "—" : formatSignedMoneyCompact(effect.net.value)}</span></p>
    </div>
    <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
      This and the net worth change answer different questions — net worth also moves when prices shift and when you convert
      value between forms, so they rarely match.
    </p>
  </div>

  <!-- ── Honest residual: neutral context, never an error banner ── -->
  {#if unexplainedMaterial}
    <div class="section-rule pt-7 text-[13px] leading-relaxed">
      <p class="text-fg-muted">
        {formatSignedMoneyCompact(Math.abs(unexplained ?? 0))} of the net worth change could not be attributed to recorded
        activity or price moves.
      </p>
      <p class="mt-1 text-[11px] text-fg-faint">
        Shown, not forced into a category — the <button class="underline" onclick={() => setDashboardMode("advanced")}>reconciliation</button> (Advanced) and the
        cash details below carry the full split.
      </p>
    </div>
  {/if}

  <!-- ── Cash details: wallet turnover demoted to a disclosure ── -->
  <details class="rounded-tile border border-border/70 px-4 py-3" data-testid="cash-details">
    <summary class="cursor-pointer select-none text-[12px] text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
      Cash details — wallet turnover &amp; reconciliation
    </summary>
    <div class="mt-3 space-y-1 border-t border-border/60 pt-3 text-[13px]">
      <p class="flex items-baseline justify-between gap-3" title="Cash that entered or left your wallet. In Torn this is often temporary — players store money in banks, stocks and items.">
        <span class="text-fg-muted">Wallet turnover ({period})</span>
        <span class="tnum text-fg-muted">+{formatMoneyCompact(economy.cashFlow.income.value)} / −{formatMoneyCompact(economy.cashFlow.expenses.value)}</span>
      </p>
      {#if economy.wallet.quality !== "unavailable"}
        <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Opening wallet</span><span class="tnum text-fg">{formatMoneyCompact(economy.wallet.openingWallet)}</span></p>
        <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Expected closing</span><span class="tnum text-fg">{economy.wallet.expectedClosingWallet !== null ? formatMoneyCompact(economy.wallet.expectedClosingWallet) : "—"}</span></p>
        <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Actual closing</span><span class="tnum text-fg">{economy.wallet.closingWallet !== null ? formatMoneyCompact(economy.wallet.closingWallet) : "—"}</span></p>
        <p class="flex items-baseline justify-between gap-3">
          <span class="text-fg-muted">Unexplained</span>
          <span class="tnum {economy.wallet.residual === null ? "text-fg-faint" : Math.abs(economy.wallet.residual) < 1 ? "text-positive" : "text-warning"}">
            {economy.wallet.residual === null ? "—" : formatMoneyCompact(economy.wallet.residual)}
          </span>
        </p>
      {:else}
        <p class="text-fg-faint">No wallet snapshots anchor this range yet.</p>
      {/if}
      <p class="pt-1.5 text-[11px] leading-relaxed text-fg-faint">
        Wallet turnover is normal Torn behavior — money quickly moves into banks, stocks and items.
        Switch to <button class="underline" onclick={() => setDashboardMode("advanced")}>Advanced</button> (top of the page) for the full bridge and category detail.
      </p>
    </div>
  </details>
</section>
