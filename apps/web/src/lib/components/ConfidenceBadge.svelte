<script lang="ts">
  import type { DataConfidenceMetaDto } from "@tornscope/shared";
  import { CONFIDENCE_LABELS, confidenceTitle } from "../confidence.js";

  /**
   * Subtle dataset-confidence indicator (v0.2).
   *
   * - complete: renders nothing by default (trust needs no badge)
   * - partial / stale_permission: small pill + native tooltip explanation
   * - unavailable: muted pill — pairs with "—" value rendering, never $0
   *
   * Deliberately tiny: it sits next to card labels without overwhelming the
   * analytics pages, wraps safely on mobile and is reachable via focus.
   */
  let {
    meta,
    showComplete = false,
    tooltip,
  }: {
    meta: DataConfidenceMetaDto | null | undefined;
    /** Render the "Complete" pill where explicit confirmation is useful. */
    showComplete?: boolean;
    /** Optional override for the native tooltip text. */
    tooltip?: string | undefined;
  } = $props();

  const styles: Record<string, string> = {
    complete: "border-border text-fg-faint",
    partial: "border-warning/40 text-warning",
    stale_permission: "border-warning/40 text-warning",
    unavailable: "border-border text-fg-faint",
  };
</script>

{#if meta && (showComplete || meta.confidence !== "complete")}
  <!-- The visible label ("Partial"/"Stale"/…) is the accessible text; the
       title tooltip is supplemental, matching ProvenanceBadge's convention. -->
  <span
    class="inline-flex max-w-full items-center gap-1 rounded-full border bg-surface-2 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide {styles[meta.confidence]}"
    title={tooltip ?? confidenceTitle(meta)}
  >
    {#if meta.confidence === "unavailable"}<span aria-hidden="true">—</span>{/if}
    <span class="truncate">{CONFIDENCE_LABELS[meta.confidence]}</span>
  </span>
{/if}
