<script lang="ts">
  import { onMount } from "svelte";
  import { formatDateTime, formatDate, RESOURCE_LABELS, humanLabel, type SyncHealthResponse } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import { me } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  /**
   * Sync health: per-resource progress, cursors, coverage and safe recovery
   * actions. Infrastructure monitoring lives in server logs / Docker.
   */

  type Health = SyncHealthResponse;

    let health = $state<Health | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let syncing = $state<Record<string, boolean>>({});
  let expandedCategories = $state<Set<string>>(new Set());

  function scheduleSummaryText(sum: {
    total: number; due: number; hot: number; warm: number; cold: number; veryCold: number; retry: number; accessDenied: number;
  }): string {
    let text = `${sum.total} categories · ${sum.due} due now · ${sum.hot} hot · ${sum.warm} warm · ${sum.cold} cold · ${sum.veryCold} very cold`;
    if (sum.retry > 0) text += ` · ${sum.retry} retrying`;
    if (sum.accessDenied > 0) text += ` · ${sum.accessDenied} access denied`;
    return text;
  }

  function toggleCategories(resource: string) {
    const next = new Set(expandedCategories);
    if (next.has(resource)) next.delete(resource);
    else next.add(resource);
    expandedCategories = next;
  }
  let notice = $state<string | null>(null);
  let retrying = $state(false);
  let restarting = $state(false);

  const frequencyHint: Record<string, string> = {
    profile: "every 5 min",
    personal_stats: "hourly",
    networth: "hourly",
    drugs: "every 10 min",
    travel: "every 10 min",
    rehab: "hourly",
    money_logs: "every 10 min",
    events: "every 5 min",
    faction_basic: "hourly",
    faction: "hourly",
    ranked_wars: "6 h",
    chains: "6 h",
    organized_crimes: "hourly",
    attacks: "30 min",
    torn_catalog: "daily",
  };

  const resourceCopy: Record<string, string> = {
    profile: "Player identity, level & faction",
    personal_stats: "Long-term personal statistics",
    networth: "Wealth snapshot with breakdown",
    drugs: "Substance use from your logs",
    travel: "Flights and items bought abroad",
    rehab: "Rehabilitation visits",
    money_logs: "Income & expense ledger entries",
    events: "Torn events for your timeline",
    faction_basic: "Legacy faction snapshots",
    faction: "Faction profile, members & bank balance",
    ranked_wars: "Ranked war history (permanent)",
    chains: "Faction chain history",
    organized_crimes: "Organized crime 2.0 records",
    attacks: "Your attack record",
    torn_catalog: "Item names & market prices",
  };

  const phaseCopy: Record<string, { label: string; dot: string; text: string }> = {
    queued: { label: "Queued", dot: "bg-fg-faint", text: "text-fg-faint" },
    running: { label: "Syncing", dot: "live-dot bg-accent", text: "text-accent" },
    backfilling: { label: "Importing history", dot: "live-dot bg-accent", text: "text-accent" },
    caught_up: { label: "Caught up", dot: "bg-positive", text: "text-fg-muted" },
    partial: { label: "Partial — category failed", dot: "bg-warning", text: "text-warning" },
    failed: { label: "Failed", dot: "bg-negative", text: "text-negative" },
    // Permission-blocked: the key cannot access this source at all — a
    // permission state, never a generic sync failure.
    permission_required: { label: "Permission required", dot: "bg-warning", text: "text-warning" },
  };

  async function load() {
    error = null;
    try {
      health = await endpoints.syncHealth();
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
    }
  }

  // Client-only bootstrap: top-level calls would also run during SSR, where
  // the relative /api fetch fails. The interval handle is cleaned up on unmount.
  onMount(() => {
    void load();
    const poll = setInterval(() => void load(), 10_000);
    return () => clearInterval(poll);
  });

  async function syncNow(resource: string, force = false) {
    syncing[resource] = true;
    notice = null;
    try {
      await endpoints.syncRun(resource, force);
      notice = `Sync for ${resource} queued — the worker picks it up within a minute.`;
      setTimeout(() => void load(), 1500);
    } catch (err) {
      notice = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      syncing[resource] = false;
    }
  }

  async function retryFailed() {
    retrying = true;
    notice = null;
    try {
      const r = await endpoints.syncRetryFailed();
      notice = r.queued.length > 0 ? `Retrying ${r.queued.length} failed resource(s).` : "Nothing failed right now.";
      setTimeout(() => void load(), 1500);
    } catch (err) {
      notice = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      retrying = false;
    }
  }

  async function restartBackfill() {
    if (!confirm("Re-fetch the full history window? Existing records are kept and deduplicated.")) return;
    restarting = true;
    notice = null;
    try {
      const r = await endpoints.syncBackfill();
      notice = `Backfill restarted for ${r.queued} resources — records are deduplicated on replay.`;
      setTimeout(() => void load(), 1500);
    } catch (err) {
      notice = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      restarting = false;
    }
  }

  function phaseOf(row: Health["resources"][number]) {
    return phaseCopy[row.phase] ?? phaseCopy.queued!;
  }

  const COVERAGE_RESOURCES = ["drugs", "rehab", "money_logs", "travel", "events", "networth"] as const;

  /** Per-resource historical coverage rows for the table. */
  const coverageRows = $derived.by(() => {
    if (!health) return [];
    const requestedStart = formatDate(Math.floor((Date.now() - health.requestedHistoryDays * 86_400_000) / 1000));
    const day = (ts: number | null | undefined): string => (ts ? formatDate(ts) : "—");
    return COVERAGE_RESOURCES.map((resource) => {
      const row = health!.resources.find((r) => r.resource === resource);
      return {
        resource,
        requestedStart,
        availableFrom: day(row?.sourceEarliestAt),
        storedSince: day(row?.storedEarliestAt),
        storedUntil: day(row?.storedLatestAt),
        stopReason: row?.stopReason ?? null,
      };
    });
  });

  function stopReasonLabel(reason: string | null): string {
    switch (reason) {
      case "history_boundary_reached":
        return "history boundary reached";
      case "source_exhausted":
        return "Torn has no older rows";
      case "max_pages":
        return "page cap — incomplete";
      case "cursor_stalled":
        return "cursor stalled — incomplete";
      case "api_error":
        return "API error — incomplete";
      case null:
        return "not walked yet";
      default:
        return reason;
    }
  }

  function stopReasonStyle(reason: string | null): string {
    if (reason === "history_boundary_reached" || reason === "source_exhausted") return "border-positive/30 bg-positive/10 text-positive";
    if (reason === null) return "border-border bg-surface-2 text-fg-faint";
    return "border-warning/40 bg-warning/10 text-warning";
  }
</script>

<svelte:head><title>Sync · TornScope</title></svelte:head>

<div class="space-y-10">
  <PageHeader
    eyebrow="System"
    title="Sync status"
    description="What the worker has collected, when it will collect again, and what went wrong — if anything."
  />

  {#if notice}
    <div class="rounded-xl border border-accent/25 bg-accent/5 px-4 py-2.5 text-[13px] text-accent">{notice}</div>
  {/if}

  {#if loading && !health}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load sync status" hint={error} action={{ label: "Retry", run: () => void load() }} />
  {:else if health}
    <!-- Resources -->
    <Panel title="Resources" caption="Manual syncs are queued and rate-limited to protect your Torn API budget">
      {#snippet actions()}
        {#if !me.data?.isDemo}
        <div class="flex items-center gap-2">
          <button
            class="rounded-full border border-border-strong px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            onclick={() => void retryFailed()}
            disabled={retrying}
          >
            {retrying ? "Retrying…" : "Retry failed"}
          </button>
          <button
            class="rounded-full border border-border-strong px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            onclick={() => void restartBackfill()}
            disabled={restarting}
          >
            {restarting ? "Restarting…" : "Restart backfill"}
          </button>
        </div>
        {/if}
      {/snippet}
      {#if health.resources.length === 0}
        {#if me.data?.isDemo}
          <StateMessage state="empty" title="Demo data" hint="Synthetic example data — the demo dataset does not include live sync state." />
        {:else}
          <StateMessage state="empty" title="No sync configuration yet" hint="Connect an API key in Settings to start collecting history." />
        {/if}
      {:else}
        <ul class="divide-y divide-border">
          {#each health.resources as row (row.resource)}
            <li class="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 first:pt-0 last:pb-0">
              <div class="min-w-[220px] flex-1">
                <div class="flex items-center gap-2.5">
                  <span class="h-2 w-2 rounded-full {phaseOf(row).dot}"></span>
                  <span class="text-[13px] font-semibold capitalize text-fg">{RESOURCE_LABELS[row.resource] ?? humanLabel(row.resource)}</span>
                  <span class="text-[11px] {phaseOf(row).text}">{phaseOf(row).label}</span>
                  <span class="text-[11px] text-fg-faint">{frequencyHint[row.resource] ?? ""}</span>
                </div>
                <p class="mt-0.5 pl-[18px] text-xs text-fg-muted">{resourceCopy[row.resource] ?? ""}</p>
                {#if row.errorMessage}
                  <p class="mt-1 pl-[18px] text-xs text-negative" title={row.errorMessage}>{row.errorMessage.slice(0, 140)}</p>
                {/if}
              </div>
              <div class="flex items-center gap-8 text-xs">
                <div>
                  <p class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">Last attempt</p>
                  <p class="mt-0.5 text-fg-muted">{formatRelative(row.lastAttemptAt)}</p>
                </div>
                <div>
                  <p class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">Last success</p>
                  <p class="mt-0.5 text-fg-muted">{formatRelative(row.lastSuccessAt)}</p>
                </div>
                <div>
                  <p class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">Next run</p>
                  <p class="tnum mt-0.5 text-fg-muted">{row.nextRunAt ? formatDateTime(row.nextRunAt).slice(11) : "—"}</p>
                </div>
                <div>
                  <p class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">Records</p>
                  <p class="tnum mt-0.5 text-fg-muted">{row.recordsCollected.toLocaleString("en-US")}</p>
                </div>
                <div>
                  <p class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">API pages</p>
                  <p class="tnum mt-0.5 text-fg-muted">{row.lastWalkPages ?? "—"}</p>
                </div>
                {#if row.categories.length > 0}
                  <button
                    class="rounded-full border border-border-strong px-3.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
                    onclick={() => toggleCategories(row.resource)}
                  >
                    {expandedCategories.has(row.resource) ? "Hide" : "Show"} categories ({row.categories.length})
                  </button>
                {/if}
                {#if !me.data?.isDemo}
                <button
                  class="rounded-full border border-border-strong px-3.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                  disabled={syncing[row.resource] || row.status === "running"}
                  onclick={() => void syncNow(row.resource)}
                >
                  {row.status === "running" ? "Running…" : "Sync now"}
                </button>
                {/if}
              </div>
            </li>
            {#if expandedCategories.has(row.resource) && row.categories.length > 0}
              <li class="border-b border-border/50 bg-bg-raise/40 px-4 py-3">
                <p class="mb-2 text-[11px] text-fg-muted">{scheduleSummaryText(row.scheduleSummary)}</p>
                <div class="overflow-x-auto">
                  <table class="w-full text-left text-xs">
                    <thead>
                      <tr class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">
                        <th class="py-1.5 pr-3 font-medium">Category</th>
                        <th class="py-1.5 pr-3 font-medium">Last success</th>
                        <th class="py-1.5 pr-3 font-medium">Cursor</th>
                        <th class="py-1.5 pr-3 text-right font-medium">Pages</th>
                        <th class="py-1.5 pr-3 text-right font-medium">Inserted</th>
                        <th class="py-1.5 pr-3 font-medium">Interval</th>
                        <th class="py-1.5 pr-3 font-medium">Next run</th>
                        <th class="py-1.5 pr-3 font-medium">Status</th>
                        <th class="py-1.5 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each row.categories as cat (cat.categoryId)}
                        <tr class="border-t border-border/40">
                          <td class="py-1.5 pr-3 text-fg">{cat.title ?? cat.categoryId}</td>
                          <td class="py-1.5 pr-3 text-fg-muted">{cat.lastSuccessAt ? formatDateTime(cat.lastSuccessAt) : "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-fg-muted">{cat.lastTimestamp ? formatDateTime(cat.lastTimestamp) : "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-right text-fg-muted">{cat.lastWalkPages ?? "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-right text-fg-muted">{cat.lastRecordsInserted ?? "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-fg-muted">{cat.frequencySeconds ? Math.round(cat.frequencySeconds / 60) + "m" : "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-fg-muted">{cat.nextRunAt ? formatRelative(cat.nextRunAt) : "—"}</td>
                          <td class="py-1.5 pr-3">
                            <span class={`rounded-full border px-2 py-0.5 text-[10px] ${cat.status === "active" ? "border-positive/30 bg-positive/10 text-positive" : cat.status === "source_exhausted" ? "border-border bg-surface-2 text-fg-faint" : "border-warning/40 bg-warning/10 text-warning"}`}>{cat.status}</span>
                          </td>
                          <td class="max-w-[220px] truncate py-1.5 text-negative" title={cat.errorMessage ?? ""}>{cat.errorMessage ?? ""}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </Panel>

    <!-- Historical coverage -->
    <Panel title="Historical coverage" caption={`Requested history: ${health.requestedHistoryDays} days — what Torn still exposes vs what is actually stored`}>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-[13px]">
          <thead>
            <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
              <th class="py-2.5 pr-4 font-medium">Resource</th>
              <th class="py-2.5 pr-4 font-medium">Requested start</th>
              <th class="py-2.5 pr-4 font-medium">Available from Torn</th>
              <th class="py-2.5 pr-4 font-medium">Stored since</th>
              <th class="py-2.5 pr-4 font-medium">Stored until</th>
              <th class="py-2.5 font-medium">Stop reason</th>
            </tr>
          </thead>
          <tbody>
            {#each coverageRows as row (row.resource)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2.5 pr-4 font-medium capitalize text-fg">{row.resource.replace(/_/g, " ")}</td>
                <td class="tnum py-2.5 pr-4 text-fg-muted">{row.requestedStart}</td>
                <td class="tnum py-2.5 pr-4 text-fg-muted">{row.availableFrom}</td>
                <td class="tnum py-2.5 pr-4 text-fg-muted">{row.storedSince}</td>
                <td class="tnum py-2.5 pr-4 text-fg-muted">{row.storedUntil}</td>
                <td class="py-2.5">
                  <span class={`rounded-full border px-2 py-0.5 text-[11px] ${stopReasonStyle(row.stopReason)}`}>{stopReasonLabel(row.stopReason)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="mt-4 text-[11px] leading-relaxed text-fg-faint">
        TornScope imports up to 180 days of available Torn history. Retention varies by Torn log type — when Torn no longer returns older
        rows the walk stops with "Torn has no older rows"; nothing is fabricated to fill the gap.
      </p>
    </Panel>

    <p class="max-w-2xl text-xs leading-relaxed text-fg-faint">
      The worker enqueues due resources every minute, runs one job at a time and spaces Torn API requests at roughly
      85 per minute (Torn allows 100). Overlapping runs are prevented by a resource lock with progress heartbeats;
      a run without progress for 15 minutes is recovered automatically. "Restart backfill" re-fetches the full window —
      existing records are kept and deduplicated.
    </p>
  {/if}
</div>
