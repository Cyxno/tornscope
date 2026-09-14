<script lang="ts">
  import type { EconomySummaryResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoneyCompact, formatDate } from "@tornscope/shared";
  import { setDashboardMode } from "$lib/state.svelte";
  import ConfidenceBadge from "./ConfidenceBadge.svelte";

  /**
   * Economy — SIMPLE presentation (product simplification).
   *
   * Answers, in order: "Did I get richer or poorer (official snapshot
   * delta)?", "What changed (category moves)?", "Did I actually earn or
   * spend value (economic effect — conversions excluded)?", "What moved
   * between forms (asset shifts)?" Wallet TURNOVER is deliberately NOT a
   * headline: in Torn players store wealth outside the wallet, so tens of
   * millions flowing through is normal, not performance. It stays available
   * in the cash-details disclosure and in Advanced mode.
   *
   * Semantics are never simplified away: estimates stay labeled, the
   * unexplained residual surfaces when material, and partial coverage is
   * disclosed.
   */

  let { economy, period }: { economy: EconomySummaryResponse; period: string } = $props();

  const nw = $derived(economy.networth);
  const effect = $derived(economy.economicEffect);
  const changed = $derived.by(() => [...nw.byCategory].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 5));
  // The net-worth-vs-economic-effect gap: net worth includes asset (price)
  // moves and conversions; economic effect does not. Never force a balance.
  const unexplained = $derived(economy.explanation.netWorthUnexplained);
  const unexplainedMaterial = $derived(
    unexplained !== null && Math.abs(unexplained) > Math.max(1_000, Math.abs(nw.change.value ?? 0) * 0.02)
  );
  const shifts = $derived.by(() => {
    const rows: Array<{ label: string; amount: string; hint: string }> = [];
    const into = economy.conversions.cashIntoAssets.value;
    const out = economy.conversions.assetsIntoCash.value;
    if (into !== null && into > 0) rows.push({ label: "Into assets", amount: formatMoneyCompact(into), hint: "Cash spent on stocks, items, points, banks — value you still own in another form" });
    if (out !== null && out > 0) rows.push({ label: "Into cash", amount: formatMoneyCompact(out), hint: "Cash received from selling owned value — not earnings" });
    if (economy.conversions.bankTransfers > 0) rows.push({ label: "Bank transfers", amount: formatMoneyCompact(economy.conversions.bankTransfers), hint: "Internal movements between wallet and bank" });
    return rows;
  });
  const topMovements = $derived(economy.majorMovements.slice(0, 3));
  const movementTone = (role: string): string => (role === "income" ? "text-positive" : role === "expense" ? "text-negative" : "text-fg");
</script>

<section aria-label="Economy summary" class="space-y-9">
  <!-- ── Hero: the official wealth result ── -->
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

  <!-- ── What changed: official category moves, biggest first ── -->
  {#if nw.byCategory.length > 0}
    <div class="section-rule pt-7">
      <p class="section-label">What changed</p>
      <p class="mt-1 text-[11px] text-fg-faint">Official category movements — largest first. Non-cash moves include price changes.</p>
      <ul class="mt-4 space-y-2.5">
        {#each changed as c (c.key)}
          <li class="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
            <span class="text-[13.5px] text-fg-muted">
              {c.label}{#if c.key !== "cash"}<span class="ml-1.5 text-[10px] uppercase tracking-wide text-fg-faint">incl. price moves</span>{/if}
            </span>
            <span class="tnum text-[13.5px] font-medium {c.change >= 0 ? "text-positive" : "text-negative"}">{formatSignedMoneyCompact(c.change)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- ── Real gains & costs: true economics, conversions excluded ── -->
  <div class="section-rule pt-7">
    <div class="flex items-center justify-between gap-2">
      <p class="section-label">Real gains &amp; costs</p>
      <ConfidenceBadge meta={effect.confidence} />
    </div>
    <p class="mt-1 text-[11px] text-fg-faint" title="Known income minus true costs. Moving money between assets does not count.">
      Known income minus true costs — moving money between assets does not count.
    </p>
    <div class="mt-4 space-y-2 text-sm">
      <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Income</span><span class="tnum font-medium text-positive">+{formatMoneyCompact(effect.income.value)}</span></p>
      <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Costs</span><span class="tnum font-medium text-negative">−{formatMoneyCompact(effect.expenses.value)}</span></p>
      <p class="flex items-baseline justify-between gap-3 border-t border-border pt-2"><span class="text-fg">Economic effect</span><span class="tnum text-[15px] font-semibold {(effect.net.value ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">{effect.net.value === null ? "—" : formatSignedMoneyCompact(effect.net.value)}</span></p>
    </div>
    <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
      This and the net worth change answer different questions — net worth also moves when prices shift and when you convert
      value between forms, so they rarely match.
    </p>
  </div>

  <!-- ── Asset shifts: value changing form ── -->
  {#if shifts.length > 0}
    <div class="section-rule pt-7">
      <p class="section-label">Asset shifts</p>
      <p class="mt-1 text-[11px] text-fg-faint">Value changing form — not gains, not losses.</p>
      <ul class="mt-3 space-y-2">
        {#each shifts as s (s.label)}
          <li class="flex items-baseline justify-between gap-4 text-sm" title={s.hint}>
            <span class="text-fg-muted">{s.label}</span>
            <span class="tnum font-medium text-fg">{s.amount}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- ── What mattered: the largest recorded movements ── -->
  {#if topMovements.length > 0}
    <div class="section-rule pt-7">
      <p class="section-label">What mattered most</p>
      <ul class="mt-3 space-y-2">
        {#each topMovements as m (m.id)}
          <li class="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 last:border-0">
            <span class="min-w-0 truncate text-[13.5px] text-fg-muted" title={m.description ?? m.label}>{m.label}</span>
            <span class="tnum shrink-0 text-[13.5px] font-medium {movementTone(m.role)}">{formatMoneyCompact(m.amount)}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- ── Honesty: unexplained residual, when material ── -->
  {#if unexplainedMaterial}
    <div class="rounded-tile border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
      <span class="font-medium">Unexplained {formatSignedMoneyCompact(unexplained)} of the net worth change.</span>
      Recorded events don't fully explain the snapshot move — the remainder is shown, not forced into a category.
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
