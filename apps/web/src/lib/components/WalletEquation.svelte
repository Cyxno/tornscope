<script lang="ts">
  import { formatMoneyFull } from "@tornscope/shared";
  import * as td from "$lib/time-display.svelte.js";

  /**
   * Inspectable wallet equation for one day (real-user finding: the "Cash"
   * why-it-moved row read like unexplained money). Shows opening + known
   * received − known spent = expected closing against the actual closing,
   * with the graded residual — the SAME canonical reconciliation the Economy
   * page uses, so the two pages cannot disagree. Uncertainty is preserved:
   * "Partially reconciled" and "Unexplained movement" states are explicit,
   * never silently collapsed into a confident-looking number.
   */

  interface WalletEquation {
    opening: number | null;
    openingAt: number | null;
    knownReceived: number;
    knownSpent: number;
    expectedClosing: number | null;
    actualClosing: number | null;
    residual: number | null;
    coverage: "full" | "partial" | "unavailable";
    quality: "exact" | "small_residual" | "partial" | "unreconciled" | "unavailable";
  }

  let { wallet }: { wallet: WalletEquation } = $props();

  const QUALITY_LABELS: Record<WalletEquation["quality"], { label: string; cls: string; hint: string }> = {
    exact: {
      label: "Fully reconciled",
      cls: "border-positive/30 bg-positive/5 text-positive",
      hint: "Every recorded movement reconciles — the ledger explains the whole day's cash change.",
    },
    small_residual: {
      label: "Small unexplained remainder",
      cls: "border-warning/30 bg-warning/5 text-warning",
      hint: "A tiny share of the day's cash movement is not covered by recorded events (rounding or an unmapped log entry).",
    },
    partial: {
      label: "Partially reconciled",
      cls: "border-warning/30 bg-warning/5 text-warning",
      hint: "Money-log history for this day is not proven complete — the residual may shrink as logs settle.",
    },
    unreconciled: {
      label: "Unexplained movement",
      cls: "border-negative/30 bg-negative/5 text-warning",
      hint: "A meaningful share of the day's cash change is not covered by recorded events — shown, never hidden or forced into income or spending.",
    },
    unavailable: {
      label: "Not reconcilable",
      cls: "border-border bg-surface-2 text-fg-faint",
      hint: "No wallet snapshots anchor this day, so the equation cannot be checked.",
    },
  };
  const quality = $derived(QUALITY_LABELS[wallet.quality]);

  /** The shared package has no signed full-precision money formatter. */
  function formatSignedMoneyFull(v: number): string {
    return `${v < 0 ? "−" : "+"}${formatMoneyFull(Math.abs(v))}`;
  }
</script>

<details class="mt-5 rounded-tile border border-border/70 px-4 py-3">
  <summary class="flex cursor-pointer select-none flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
    <span class="font-medium">Why did cash move?</span>
    <span class="tnum text-fg-faint">
      {wallet.opening !== null ? formatMoneyFull(wallet.opening) : "—"}
      → {wallet.actualClosing !== null ? formatMoneyFull(wallet.actualClosing) : "—"}
    </span>
    <span class="rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] {quality.cls}">{quality.label}</span>
  </summary>
  <div class="mt-3 space-y-1 border-t border-border/60 pt-3 text-[13px]" data-testid="wallet-equation">
    <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Opening wallet{wallet.openingAt !== null ? ` · ${td.displayDateTime(wallet.openingAt)}` : ""}</span><span class="tnum text-fg">{wallet.opening !== null ? formatMoneyFull(wallet.opening) : "—"}</span></p>
    <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Known cash in</span><span class="tnum text-fg">+{formatMoneyFull(wallet.knownReceived)}</span></p>
    <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Known cash out</span><span class="tnum text-fg">−{formatMoneyFull(wallet.knownSpent)}</span></p>
    <p class="flex items-baseline justify-between gap-3 border-t border-border/60 pt-1.5"><span class="text-fg">Expected closing</span><span class="tnum font-medium text-fg">{wallet.expectedClosing !== null ? formatMoneyFull(wallet.expectedClosing) : "—"}</span></p>
    <p class="flex items-baseline justify-between gap-3"><span class="text-fg-muted">Actual closing wallet</span><span class="tnum text-fg">{wallet.actualClosing !== null ? formatMoneyFull(wallet.actualClosing) : "—"}</span></p>
    {#if wallet.residual !== null && wallet.quality !== "exact"}
      <p class="flex items-baseline justify-between gap-3"><span class="font-medium text-warning">Unexplained</span><span class="tnum font-medium text-warning">{formatSignedMoneyFull(wallet.residual)}</span></p>
    {/if}
    <p class="pt-1.5 text-[11px] leading-relaxed text-fg-faint">{quality.hint}</p>
  </div>
</details>
