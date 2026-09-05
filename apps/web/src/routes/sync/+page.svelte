<script lang="ts">
  import { onDestroy } from "svelte";
  import { formatDateTime, type SyncHealthResponse } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import { me } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  /**
   * Sync & system health: PostgreSQL / Redis / worker / Torn, BullMQ queue
   * depths, per-resource progress and safe recovery actions.
   */

  type Health = SyncHealthResponse;

    let health = $state<Health | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let syncing = $state<Record<string, boolean>>({});
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
    faction_basic: "every 6 h",
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
    faction_basic: "Faction identity & snapshots",
    torn_catalog: "Item names & market prices",
  };

  const phaseCopy: Record<string, { label: string; dot: string; text: string }> = {
    queued: { label: "Queued", dot: "bg-fg-faint", text: "text-fg-faint" },
    running: { label: "Syncing", dot: "live-dot bg-accent", text: "text-accent" },
    backfilling: { label: "Importing history", dot: "live-dot bg-accent", text: "text-accent" },
    caught_up: { label: "Caught up", dot: "bg-positive", text: "text-fg-muted" },
    failed: { label: "Failed", dot: "bg-negative", text: "text-negative" },
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

  void load();
  const poll = setInterval(() => void load(), 10_000);
  onDestroy(() => clearInterval(poll));

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

  function systemDot(state: string | boolean): string {
    const up = state === "up" || state === true;
    return up ? "bg-positive" : "bg-negative";
  }

  function phaseOf(row: Health["resources"][number]) {
    return phaseCopy[row.phase] ?? phaseCopy.queued!;
  }
</script>

<div class="space-y-10">
  <PageHeader
    eyebrow="System"
    title="Sync status"
    description="What the worker has collected, when it will collect again, and what went wrong — if anything."
  >
    {#snippet actions()}
      <span class="hidden rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg-faint sm:inline" title="Deployed build">
        build {health?.build.commit ?? me.data?.build.commit ?? "dev"}
      </span>
    {/snippet}
  </PageHeader>

  {#if notice}
    <div class="rounded-xl border border-accent/25 bg-accent/5 px-4 py-2.5 text-[13px] text-accent">{notice}</div>
  {/if}

  {#if loading && !health}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load sync status" hint={error} action={{ label: "Retry", run: () => void load() }} />
  {:else if health}
    <!-- System health -->
    <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between"><span class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">PostgreSQL</span><span class="h-2 w-2 rounded-full {systemDot(health.system.postgres)}"></span></div>
        <p class="mt-2.5 text-sm font-medium text-fg capitalize">{health.system.postgres}</p>
      </div>
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between"><span class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Redis</span><span class="h-2 w-2 rounded-full {systemDot(health.system.redis)}"></span></div>
        <p class="mt-2.5 text-sm font-medium text-fg capitalize">{health.system.redis}</p>
      </div>
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between"><span class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Worker</span><span class="h-2 w-2 rounded-full {systemDot(health.system.worker.online)}"></span></div>
        <p class="mt-2.5 text-sm font-medium text-fg">{health.system.worker.online ? "Online" : "Offline"}</p>
        <p class="mt-0.5 text-xs text-fg-faint">{health.system.worker.lastHeartbeatAt ? `beat ${formatRelative(health.system.worker.lastHeartbeatAt)}` : "no heartbeat"}</p>
      </div>
      <div class="bg-surface p-5">
        <div class="flex items-center justify-between"><span class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Torn API</span><span class="h-2 w-2 rounded-full {health.system.tornApi.lastError ? 'bg-warning' : 'bg-positive'}"></span></div>
        <p class="mt-2.5 text-sm font-medium text-fg">{health.system.tornApi.lastError ? "Last error" : "No errors"}</p>
        {#if health.system.tornApi.lastError}
          <p class="mt-0.5 truncate text-xs text-fg-faint" title={health.system.tornApi.lastError.message ?? ""}>{health.system.tornApi.lastError.resource}: {health.system.tornApi.lastError.message?.slice(0, 60)}</p>
        {/if}
      </div>
    </div>

    <!-- Queue health -->
    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Sync queue" caption="BullMQ · tornscope-sync">
        {#if health.queues.sync}
          <div class="grid grid-cols-5 gap-2 text-center">
            {#each Object.entries(health.queues.sync) as [k, v] (k)}
              <div class="rounded-xl border border-border bg-bg-raise px-2 py-3">
                <p class="tnum text-xl font-semibold text-fg">{v ?? 0}</p>
                <p class="mt-1 text-[10px] uppercase tracking-[0.12em] text-fg-faint">{k}</p>
              </div>
            {/each}
          </div>
        {:else}
          <p class="text-sm text-fg-muted">Queue counts unavailable (Redis down?).</p>
        {/if}
      </Panel>
      <Panel title="Scheduler" caption="Repeating tick · tornscope-scheduler">
        {#if health.queues.scheduler}
          <div class="grid grid-cols-5 gap-2 text-center">
            {#each Object.entries(health.queues.scheduler) as [k, v] (k)}
              <div class="rounded-xl border border-border bg-bg-raise px-2 py-3">
                <p class="tnum text-xl font-semibold text-fg">{v ?? 0}</p>
                <p class="mt-1 text-[10px] uppercase tracking-[0.12em] text-fg-faint">{k}</p>
              </div>
            {/each}
          </div>
          <p class="mt-3 text-xs text-fg-faint">{health.queues.note}</p>
        {:else}
          <p class="text-sm text-fg-muted">Queue counts unavailable (Redis down?).</p>
        {/if}
      </Panel>
    </section>

    <!-- Resources -->
    <Panel title="Resources" caption="Manual syncs are queued and rate-limited to protect your Torn API budget">
      {#snippet actions()}
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
      {/snippet}
      {#if health.resources.length === 0}
        <StateMessage state="empty" title="No sync configuration yet" hint="Connect an API key in Settings to start collecting history." />
      {:else}
        <ul class="divide-y divide-border">
          {#each health.resources as row (row.resource)}
            <li class="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 first:pt-0 last:pb-0">
              <div class="min-w-[220px] flex-1">
                <div class="flex items-center gap-2.5">
                  <span class="h-2 w-2 rounded-full {phaseOf(row).dot}"></span>
                  <span class="text-[13px] font-semibold capitalize text-fg">{row.resource.replace(/_/g, " ")}</span>
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
                  <p class="tnum mt-0.5 text-fg-muted">{row.recordsCollected.toLocaleString()}</p>
                </div>
                <button
                  class="rounded-full border border-border-strong px-3.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
                  disabled={syncing[row.resource] || row.status === "running"}
                  onclick={() => void syncNow(row.resource)}
                >
                  {row.status === "running" ? "Running…" : "Sync now"}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Panel>

    <p class="max-w-2xl text-xs leading-relaxed text-fg-faint">
      The worker enqueues due resources every minute, runs one job at a time and spaces Torn API requests at roughly
      85 per minute (Torn allows 100). Overlapping runs are prevented by a resource lock with progress heartbeats;
      a run without progress for 15 minutes is recovered automatically. "Restart backfill" re-fetches the full window —
      existing records are kept and deduplicated.
    </p>
  {/if}
</div>
