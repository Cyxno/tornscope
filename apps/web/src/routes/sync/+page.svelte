<script lang="ts">
  import { onMount } from "svelte";
  import { formatDateTime, formatDate, RESOURCE_LABELS, humanLabel, type SyncHealthResponse } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import { confidenceTitle, coverageTitle } from "$lib/confidence";
  import { OPERATIONAL_LABELS, operationalTitle, OPERATION_REASON_COPY, INCIDENT_KIND_COPY, INCIDENT_REASON_COPY, SEVERITY_STYLES } from "$lib/syncHealth";
  import { me } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ConfidenceBadge from "$lib/components/ConfidenceBadge.svelte";

  /**
   * Sync health: per-resource operational state (derived server-side by the
   * shared sync-health module — this page only maps codes to copy), data
   * confidence, recent incidents and safe recovery actions.
   */

  type Health = SyncHealthResponse;
  type ResourceRow = Health["resources"][number];

    let health = $state<Health | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let syncing = $state<Record<string, boolean>>({});
  let expandedCategories = $state<Set<string>>(new Set());
  let expandedIssues = $state<Set<string>>(new Set());
  let notice = $state<string | null>(null);
  let retrying = $state(false);
  let restarting = $state(false);

  /** Operational states where the safe "Retry now" action makes sense. */
  const RETRYABLE_STATES = new Set(["retrying", "failed", "degraded", "delayed"]);

  function toggleSet(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  function scheduleSummaryText(sum: {
    total: number; due: number; hot: number; warm: number; cold: number; veryCold: number; retry: number; accessDenied: number;
  }): string {
    let text = `${sum.total} categories · ${sum.due} due now · ${sum.hot} hot · ${sum.warm} warm · ${sum.cold} cold · ${sum.veryCold} very cold`;
    if (sum.retry > 0) text += ` · ${sum.retry} retrying`;
    if (sum.accessDenied > 0) text += ` · ${sum.accessDenied} access denied`;
    return text;
  }

  /** Friendly labels for per-category cursor statuses (never raw codes). */
  const CATEGORY_STATUS_LABELS: Record<string, string> = {
    active: "Active",
    source_exhausted: "No older rows",
    access_denied: "Access denied",
    failed: "Retrying",
  };

  function categoryStatusLabel(status: string): string {
    return CATEGORY_STATUS_LABELS[status] ?? status;
  }

  function categoryStatusStyle(status: string): string {
    if (status === "active") return "chip-positive";
    if (status === "source_exhausted") return "";
    return "chip-warning";
  }

  /** "7m" / "1h 05m" style compact duration for overdue/retry wording. */
  function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || seconds < 0) return "—";
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  }

  /** Per-state timing cell: what happens next, and when. */
  function timing(row: ResourceRow): { label: string; value: string; countdown?: string } {
    const op = row.operational;
    switch (op.state) {
      case "running":
        return { label: "Started", value: op.since ? formatRelative(op.since) : "just now" };
      case "backfilling":
        return { label: "Importing", value: "in progress" };
      case "retrying":
        return {
          label: "Retry",
          value: op.retryAt ? formatDateTime(op.retryAt).slice(11) : "pending",
          countdown: op.retryAt ? `in ${formatDuration(op.retryAt - Date.now() / 1000)}` : undefined,
        };
      case "delayed":
      case "failed":
        return { label: "Overdue by", value: formatDuration(op.overdueBySeconds) };
      case "parked":
        return { label: "Re-check", value: row.nextRunAt ? formatRelative(row.nextRunAt) : "—" };
      case "never_run":
        return { label: "Next run", value: "—" };
      default:
        return { label: "Next run", value: row.nextRunAt ? formatDateTime(row.nextRunAt).slice(11) : "—" };
    }
  }

  /** Compact 24h health line for the issues expander. */
  function metricsText(row: ResourceRow): string | null {
    const m = row.metrics;
    if (!m) return null;
    const parts: string[] = [];
    if (m.successRate24h !== null) parts.push(`${Math.round(m.successRate24h * 100)}% runs succeeded`);
    if (m.avgDurationMs24h !== null) parts.push(`avg run ${(m.avgDurationMs24h / 1000).toFixed(1)}s`);
    if (m.failures24h > 0) parts.push(`${m.failures24h} failure${m.failures24h === 1 ? "" : "s"}`);
    if (m.recoveries24h > 0) parts.push(`${m.recoveries24h} auto-recover${m.recoveries24h === 1 ? "y" : "ies"}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

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

  /** Safe "Retry now": server refuses running/parked resources explicitly. */
  async function retryNow(resource: string) {
    syncing[resource] = true;
    notice = null;
    try {
      const r = await endpoints.syncRetry(resource);
      notice = r.queued
        ? `Retry for ${resource} queued — the worker picks it up within a minute.`
        : r.refused === "running"
          ? `${resource} is already syncing.`
          : r.refused === "parked"
            ? `${resource} needs a permission change in Torn — retrying cannot help until then.`
            : `${resource} cannot be retried right now.`;
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

  function operationalOf(row: ResourceRow) {
    return OPERATIONAL_LABELS[row.operational.state] ?? OPERATIONAL_LABELS.never_run!;
  }

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
        confidence: row?.confidence ?? null,
        coverageTooltip: coverageTitle(row?.confidence?.coverage, (ts) => (ts ? formatDate(ts) : "—")),
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
    if (reason === "history_boundary_reached" || reason === "source_exhausted") return "chip-positive";
    if (reason === null) return "";
    return "chip-warning";
  }
</script>

<svelte:head><title>Sync · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="System"
    title="Sync status"
    description="What the worker has collected, when it will collect again, and what went wrong — if anything."
  />

  {#if notice}
    <div class="rounded-tile border border-accent/25 bg-accent/5 px-4 py-2.5 text-[13px] text-accent">{notice}</div>
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
          <button class="btn btn-sm" onclick={() => void retryFailed()} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry failed"}
          </button>
          <button class="btn btn-sm" onclick={() => void restartBackfill()} disabled={restarting}>
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
        <!-- Desktop: an aligned 6-column row grid. Mobile: stacked resource cards. -->
        <ul class="divide-y divide-border">
          {#each health.resources as row (row.resource)}
            {@const op = row.operational}
            {@const style = operationalOf(row)}
            {@const time = timing(row)}
            <li class="space-y-3 py-4 first:pt-0 last:pb-0 lg:grid lg:grid-cols-[minmax(230px,1.5fr)_repeat(4,minmax(70px,0.5fr))_auto] lg:items-center lg:gap-x-5 lg:space-y-0">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span class="h-2 w-2 rounded-full {style.dot}"></span>
                  <span class="text-[13px] font-semibold text-fg">{RESOURCE_LABELS[row.resource] ?? humanLabel(row.resource)}</span>
                  <!-- Operational health (is the sync loop working?) … -->
                  <span class="text-[11px] font-medium {style.text}" title={operationalTitle(op)}>{style.label}</span>
                  <span class="text-[11px] text-fg-faint">{frequencyHint[row.resource] ?? ""}</span>
                  <!-- … vs data confidence (how trustworthy is the data?) — never merged. -->
                  <ConfidenceBadge
                    meta={row.confidence}
                    showComplete
                    tooltip={confidenceTitle(row.confidence, row.lastSuccessAt ? `last refreshed ${formatRelative(row.lastSuccessAt)}` : undefined)}
                  />
                </div>
                <p class="mt-0.5 pl-[18px] text-xs text-fg-muted">{resourceCopy[row.resource] ?? ""}</p>
                {#if op.reason !== "none"}
                  <p class="mt-0.5 pl-[18px] text-xs {style.text}">
                    {INCIDENT_REASON_COPY[op.reason]}{#if op.state === "retrying" && op.retryAt}&nbsp;· retry in {formatDuration(Math.max(0, op.retryAt - Date.now() / 1000))}{/if}
                  </p>
                {/if}
                {#if row.errorMessage && (op.state === "failed" || op.state === "degraded" || op.state === "retrying")}
                  <p class="mt-1 pl-[18px] text-xs text-negative" title={row.errorMessage}>{row.errorMessage.slice(0, 140)}</p>
                {/if}
              </div>
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:contents">
                <div>
                  <p class="text-[10px] font-medium uppercase tracking-[0.11em] text-fg-faint">Last attempt</p>
                  <p class="tnum mt-0.5 text-fg-muted">{formatRelative(row.lastAttemptAt)}</p>
                </div>
                <div>
                  <p class="text-[10px] font-medium uppercase tracking-[0.11em] text-fg-faint">Last success</p>
                  <p class="tnum mt-0.5 text-fg-muted">{formatRelative(row.lastSuccessAt)}</p>
                </div>
                <div>
                  <p class="text-[10px] font-medium uppercase tracking-[0.11em] text-fg-faint">{time.label}</p>
                  <p class="tnum mt-0.5 text-fg-muted">
                    {time.value}{#if time.countdown}&nbsp;<span class="text-fg-faint">{time.countdown}</span>{/if}
                  </p>
                </div>
                <div>
                  <p class="text-[10px] font-medium uppercase tracking-[0.11em] text-fg-faint">Records</p>
                  <p class="tnum mt-0.5 text-fg-muted">
                    {row.recordsCollected.toLocaleString("en-US")}
                    {#if row.lastWalkPages !== null}
                      <span class="text-fg-faint">· {row.lastWalkPages} pages</span>
                    {/if}
                  </p>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-2 lg:justify-end">
                {#if row.recentIncidents.length > 0}
                  <button
                    class="chip chip-warning cursor-pointer !py-1.5 transition-colors hover:border-warning"
                    onclick={() => (expandedIssues = toggleSet(expandedIssues, row.resource))}
                  >
                    {row.recentIncidents.length} issue{row.recentIncidents.length === 1 ? "" : "s"} · 24h
                  </button>
                {/if}
                {#if row.categories.length > 0}
                  <button
                    class="btn btn-sm"
                    onclick={() => (expandedCategories = toggleSet(expandedCategories, row.resource))}
                  >
                    {expandedCategories.has(row.resource) ? "Hide" : "Categories"} ({row.categories.length})
                  </button>
                {/if}
                {#if !me.data?.isDemo && op.state !== "parked"}
                  {#if RETRYABLE_STATES.has(op.state)}
                    <button
                      class="btn btn-sm btn-accent"
                      disabled={syncing[row.resource]}
                      onclick={() => void retryNow(row.resource)}
                    >
                      {syncing[row.resource] ? "Retrying…" : "Retry now"}
                    </button>
                  {:else}
                    <button
                      class="btn btn-sm"
                      disabled={syncing[row.resource] || op.state === "running" || op.state === "backfilling" || op.state === "stale_running"}
                      title={op.state === "stale_running" ? "Automatic recovery is already in progress" : op.state === "running" || op.state === "backfilling" ? "This resource is syncing right now" : undefined}
                      onclick={() => void syncNow(row.resource)}
                    >
                      {op.state === "running" || op.state === "backfilling" ? "Running…" : "Sync now"}
                    </button>
                  {/if}
                {/if}
              </div>
              {#if expandedIssues.has(row.resource) && row.recentIncidents.length > 0}
                <div class="w-full rounded-tile border border-warning/25 bg-warning/5 px-4 py-3 lg:col-span-6">
                  <p class="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-warning">Recent issues</p>
                  <ul class="space-y-1.5">
                    {#each row.recentIncidents as incident (incident.startedAt)}
                      <li class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                        <span class={`chip ${SEVERITY_STYLES[incident.severity]}`}>{INCIDENT_KIND_COPY[incident.kind]}</span>
                        <span>{INCIDENT_REASON_COPY[incident.reason]}</span>
                        <span class="text-fg-faint">{formatRelative(incident.startedAt)}</span>
                        {#if incident.failureCount > 1}<span class="text-fg-faint">×{incident.failureCount}</span>{/if}
                        {#if incident.autoRecovered}
                          <span class="chip chip-positive !text-[10px]">auto-recovered</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                  {#if metricsText(row)}
                    <p class="mt-2 text-[11px] text-fg-faint">24h: {metricsText(row)}</p>
                  {/if}
                </div>
              {/if}
            </li>
            {#if expandedCategories.has(row.resource) && row.categories.length > 0}
              <li class="border-b border-border/50 bg-bg-raise/40 px-4 py-3 lg:col-span-6">
                <p class="mb-2 text-[11px] text-fg-muted">{scheduleSummaryText(row.scheduleSummary)}</p>
                <div class="overflow-x-auto">
                  <table class="tsv-table !text-xs">
                    <thead>
                      <tr class="text-[10px] uppercase tracking-[0.12em] text-fg-faint">
                        <th class="font-medium">Category</th>
                        <th class="font-medium">Last success</th>
                        <th class="font-medium">Cursor</th>
                        <th class="text-right font-medium">Pages</th>
                        <th class="text-right font-medium">Inserted</th>
                        <th class="font-medium">Interval</th>
                        <th class="font-medium">Next run</th>
                        <th class="font-medium">Status</th>
                        <th class="font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each row.categories as cat (cat.categoryId)}
                        <tr class="border-t border-border/40">
                          <td class="text-fg">{cat.title ?? cat.categoryId}</td>
                          <td class="text-fg-muted">{cat.lastSuccessAt ? formatDateTime(cat.lastSuccessAt) : "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-fg-muted">{cat.lastTimestamp ? formatDateTime(cat.lastTimestamp) : "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-right text-fg-muted">{cat.lastWalkPages ?? "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-right text-fg-muted">{cat.lastRecordsInserted ?? "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-fg-muted">{cat.frequencySeconds ? Math.round(cat.frequencySeconds / 60) + "m" : "—"}</td>
                          <td class="tnum py-1.5 pr-3 text-fg-muted">{cat.nextRunAt ? formatRelative(cat.nextRunAt) : "—"}</td>
                          <td class="pr-3">
                            <span class={`chip ${categoryStatusStyle(cat.status)}`}>{categoryStatusLabel(cat.status)}</span>
                          </td>
                          <td class="max-w-[220px] truncate text-negative" title={cat.errorMessage ?? ""}>{cat.errorMessage ?? ""}</td>
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
        <table class="tsv-table">
          <thead>
            <tr>
              <th class="font-medium">Resource</th>
              <th class="font-medium">Requested start</th>
              <th class="font-medium">Available from Torn</th>
              <th class="font-medium">Stored since</th>
              <th class="font-medium">Stored until</th>
              <th class="font-medium">Confidence</th>
              <th>Stop reason</th>
            </tr>
          </thead>
          <tbody>
            {#each coverageRows as row (row.resource)}
              <tr>
                <td class="font-medium capitalize text-fg">{row.resource.replace(/_/g, " ")}</td>
                <td class="tnum text-fg-muted">{row.requestedStart}</td>
                <td class="tnum text-fg-muted">{row.availableFrom}</td>
                <td class="tnum text-fg-muted">{row.storedSince}</td>
                <td class="tnum text-fg-muted">{row.storedUntil}</td>
                <td class="">
                  <ConfidenceBadge meta={row.confidence} showComplete tooltip={confidenceTitle(row.confidence, row.coverageTooltip)} />
                </td>
                <td class="">
                  <span class={`chip ${stopReasonStyle(row.stopReason)}`}>{stopReasonLabel(row.stopReason)}</span>
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
      <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
        <span class="font-medium text-fg-muted">Operational status</span> (Queued / Syncing / Failed) answers whether the worker is
        functioning. <span class="font-medium text-fg-muted">Confidence</span> (Complete / Partial / Stale / Unavailable) answers how
        complete and trustworthy the collected data is — the two are tracked separately.
      </p>
    </Panel>

    <p class="max-w-2xl text-xs leading-relaxed text-fg-faint">
      The worker enqueues due resources every minute, runs one job at a time and spaces Torn API requests at roughly
      85 per minute (Torn allows 100). Overlapping runs are prevented by a resource lock with progress heartbeats;
      a run without progress for 15 minutes is recovered automatically. "Retry now" re-queues a troubled resource
      within safe rate limits — it never resets cursors or deletes history. "Restart backfill" re-fetches the full
      window; existing records are kept and deduplicated.
    </p>
  {/if}
</div>
