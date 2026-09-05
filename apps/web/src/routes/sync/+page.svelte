<script lang="ts">
  import type { SyncStatusResponse } from "@tornscope/shared";
  import { formatDateTime } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  let status = $state<SyncStatusResponse | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let syncing = $state<Record<string, boolean>>({});
  let notice = $state<string | null>(null);

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

  async function load() {
    error = null;
    try {
      status = await endpoints.syncStatus();
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
    }
  }

  void load();
  const poll = setInterval(() => void load(), 10_000);
  import { onDestroy } from "svelte";
  onDestroy(() => clearInterval(poll));

  async function syncNow(resource: string) {
    syncing[resource] = true;
    notice = null;
    try {
      await endpoints.syncRun(resource);
      notice = `Sync for ${resource} queued — the worker picks it up within a minute.`;
      setTimeout(() => void load(), 1500);
    } catch (err) {
      notice = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      syncing[resource] = false;
    }
  }

  function statusStyle(s: string): { dot: string; label: string; text: string } {
    if (s === "running") return { dot: "live-dot bg-accent", label: "Running", text: "text-accent" };
    if (s === "failed") return { dot: "bg-negative", label: "Failed", text: "text-negative" };
    if (s === "idle") return { dot: "bg-positive", label: "Healthy", text: "text-fg-muted" };
    return { dot: "bg-fg-faint", label: s, text: "text-fg-muted" };
  }
</script>

<div class="space-y-10">
  <PageHeader
    eyebrow="System"
    title="Sync status"
    description="What the worker has collected, when it will collect again, and what went wrong — if anything."
  />

  {#if notice}
    <div class="rounded-xl border border-accent/25 bg-accent/5 px-4 py-2.5 text-[13px] text-accent">{notice}</div>
  {/if}

  {#if loading && !status}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load sync status" hint={error} action={{ label: "Retry", run: () => void load() }} />
  {:else if status}
    <Panel title="Resources" caption="Manual syncs are queued and rate-limited to protect your Torn API budget">
      {#if status.resources.length === 0}
        <StateMessage state="empty" title="No sync configuration yet" hint="Connect an API key in Settings to start collecting history." />
      {:else}
        <ul class="divide-y divide-border">
          {#each status.resources as row (row.resource)}
            <li class="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 first:pt-0 last:pb-0">
              <div class="min-w-[220px] flex-1">
                <div class="flex items-center gap-2.5">
                  <span class="h-2 w-2 rounded-full {statusStyle(row.status).dot}"></span>
                  <span class="text-[13px] font-semibold capitalize text-fg">{row.resource.replace(/_/g, " ")}</span>
                  <span class="text-[11px] text-fg-faint">{frequencyHint[row.resource] ?? ""}</span>
                </div>
                <p class="mt-0.5 pl-[18px] text-xs text-fg-muted">{resourceCopy[row.resource] ?? ""}</p>
                {#if row.errorMessage}
                  <p class="mt-1 pl-[18px] text-xs text-negative" title={row.errorMessage}>{row.errorMessage.slice(0, 120)}</p>
                {/if}
              </div>
              <div class="flex items-center gap-8 text-xs">
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
      85 per minute (Torn allows 100). Overlapping runs are prevented by a resource lock; crashed runs recover after 15 minutes.
    </p>
  {/if}
</div>
