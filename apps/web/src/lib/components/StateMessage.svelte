<script lang="ts">
  let { state, title, hint, action }: { state: "loading" | "error" | "empty" | "permission" | "stale"; title?: string | null; hint?: string | null; action?: { label: string; run: () => void } } = $props();

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

  const icon: Record<string, string> = { loading: "◌", error: "!", empty: "◌", permission: "⚿", stale: "⏱" };
</script>

{#if state === "loading"}
  <div class="space-y-3" data-testid="skeleton">
    <div class="skeleton h-24 w-full"></div>
    <div class="skeleton h-64 w-full"></div>
    <div class="skeleton h-40 w-2/3"></div>
  </div>
{:else}
  <div class="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed {state === 'permission' || state === 'stale' ? 'border-warning/40 bg-warning/[0.03]' : 'border-border bg-bg-raise/50'} px-8 py-12 text-center">
    <span class="flex h-10 w-10 items-center justify-center rounded-full bg-surface {state === 'permission' || state === 'stale' ? 'text-warning' : 'text-fg-faint'}">
      {icon[state]}
    </span>
    <p class="text-sm font-semibold text-fg">{title ?? defaults[state].title}</p>
    {#if hint || state === "empty" || state === "permission" || state === "stale"}
      <p class="max-w-md text-[13px] leading-relaxed text-fg-muted">{hint ?? defaults[state].hint}</p>
    {/if}
    {#if action}
      <button class="mt-1 rounded-full border border-border-strong px-4 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent" onclick={action.run}>
        {action.label}
      </button>
    {/if}
  </div>
{/if}
