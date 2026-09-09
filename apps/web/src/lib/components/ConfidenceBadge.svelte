<script lang="ts">
  import type { DataConfidenceMetaDto } from "@tornscope/shared";
  import { CONFIDENCE_LABELS, confidenceTitle } from "../confidence.js";

  /**
   * Subtle dataset-confidence indicator (v0.2).
   *
   * - complete: renders nothing by default (trust needs no badge)
   * - partial / stale_permission: small warning chip + native tooltip
   * - unavailable: muted chip — pairs with "—" value rendering, never $0
   *
   * Deliberately tiny: it sits next to KPI labels without overwhelming the
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
    complete: "",
    partial: "chip-warning",
    stale_permission: "chip-warning",
    unavailable: "",
  };
</script>

{#if meta && (showComplete || meta.confidence !== "complete")}
  <!-- The visible label ("Partial"/"Stale"/…) is the accessible text; the
       title tooltip is supplemental, matching ProvenanceBadge's convention. -->
  <span
    class="chip {meta.confidence === 'unavailable' ? 'border-border bg-transparent !text-fg-faint' : styles[meta.confidence]} !px-1.5 !text-[9px] !font-semibold !uppercase !tracking-wide"
    title={tooltip ?? confidenceTitle(meta)}
  >
    {#if meta.confidence === "unavailable"}<span aria-hidden="true">—</span>{/if}
    <span class="truncate">{CONFIDENCE_LABELS[meta.confidence]}</span>
  </span>
{/if}
