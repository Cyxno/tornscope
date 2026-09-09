<script lang="ts">
  import Icon from "./Icon.svelte";
  import type { IconName } from "./Icon.svelte";

  /**
   * Shared loading / empty / error / permission / stale presentation.
   * - loading: structure-matched skeletons (stat strip, chart block, rows)
   * - permission/stale: distinct from "no data" — missing is not zero
   * - error: calm, no stack traces, safe retry
   */
  let {
    state,
    title,
    hint,
    action,
    skeleton = "page",
    compact = false,
  }: {
    state: "loading" | "error" | "empty" | "permission" | "stale";
    title?: string | null;
    hint?: string | null;
    action?: { label: string; run: () => void };
    /** Loading skeleton shape: "page" (full), "strip" (stat row), "chart", "rows". */
    skeleton?: "page" | "strip" | "chart" | "rows";
    /** Compact rendering for inside panels. */
    compact?: boolean;
  } = $props();

  const defaults = {
    loading: { title: "Loading", hint: "Fetching your data…" },
    error: { title: "Something went wrong", hint: null },
    empty: { title: "Nothing here yet", hint: "Historical data accumulates as the sync worker runs. Connect a key or wait for the next sync." },
    // Permission-gated: this data is missing because the API key does not
    // grant it — NEVER rendered as zeros or "no data".
    permission: { title: "Unavailable with current API permissions", hint: "Your connected API key does not include the data source this section needs." },
    // Stored history exists but the current key can no longer refresh it.
    stale: { title: "Historical data — no longer refreshing", hint: "Previously collected data is still available below. The current API key cannot refresh this dataset." },
  };

  const icon: Record<string, IconName> = { empty: "overview", error: "alert", permission: "alert", stale: "clock" };
</script>

{#if state === "loading"}
  <div class="space-y-3" data-testid="skeleton" aria-busy="true" aria-label="Loading">
    {#if skeleton === "strip"}
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border md:grid-cols-4">
        {#each Array(4) as _, i (i)}
          <div class="bg-surface p-5">
            <div class="skeleton h-3 w-20"></div>
            <div class="skeleton mt-3 h-6 w-24"></div>
          </div>
        {/each}
      </div>
    {:else if skeleton === "chart"}
      <div class="rounded-card border border-border bg-surface p-5">
        <div class="skeleton h-3 w-32"></div>
        <div class="skeleton mt-4 h-[220px] w-full"></div>
      </div>
    {:else if skeleton === "rows"}
      <div class="rounded-card border border-border bg-surface p-5">
        {#each Array(5) as _, i (i)}
          <div class="flex items-center justify-between border-b border-border/50 py-3 last:border-0">
            <div class="skeleton h-3.5 {i % 2 ? 'w-40' : 'w-56'}"></div>
            <div class="skeleton h-3.5 w-16"></div>
          </div>
        {/each}
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border md:grid-cols-4">
        {#each Array(4) as _, i (i)}
          <div class="bg-surface p-5">
            <div class="skeleton h-3 w-20"></div>
            <div class="skeleton mt-3 h-6 w-24"></div>
          </div>
        {/each}
      </div>
      <div class="rounded-card border border-border bg-surface p-5">
        <div class="skeleton h-3 w-32"></div>
        <div class="skeleton mt-4 h-[220px] w-full"></div>
      </div>
    {/if}
  </div>
{:else}
  <div
    class="flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-card border border-dashed px-6 py-10 text-center {compact ? 'min-h-[120px] py-6' : ''} {state === 'permission' || state === 'stale'
      ? 'border-warning/35 bg-warning/[0.03]'
      : 'border-border bg-bg-raise/50'}"
  >
    <span
      class="flex h-9 w-9 items-center justify-center rounded-full border {state === 'permission' || state === 'stale'
        ? 'border-warning/30 text-warning'
        : state === 'error'
          ? 'border-negative/30 text-negative'
          : 'border-border text-fg-faint'}"
    >
      <Icon name={icon[state]} size={15} />
    </span>
    <p class="text-sm font-semibold text-fg">{title ?? defaults[state].title}</p>
    {#if hint || state === "empty" || state === "permission" || state === "stale"}
      <p class="max-w-md text-[13px] leading-relaxed text-fg-muted">{hint ?? defaults[state].hint}</p>
    {/if}
    {#if action}
      <button class="btn btn-sm mt-1" onclick={action.run}>{action.label}</button>
    {/if}
  </div>
{/if}
