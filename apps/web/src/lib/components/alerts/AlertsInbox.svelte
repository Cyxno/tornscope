<script lang="ts">
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import { displayDateTime } from "$lib/time-display.svelte";
  import { alertUnread, refreshAlertUnread } from "$lib/state.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { ALERT_DELIVERY_STATUS_LABELS } from "@tornscope/shared";
  import type {
    AlertDeliveriesResponse,
    AlertDeliveryDto,
    AlertDeliveryStatus,
    AlertRulesResponse,
    AlertTriggerId,
  } from "@tornscope/shared";

  /**
   * In-app inbox: reverse-chronological logical alerts. `status` is the
   * IN-APP delivery state; per-Discord states render as their own chips so
   * the two never blur. Cursor-based "Load more" and a trigger filter.
   */

  const STATUS_TONES: Record<AlertDeliveryStatus, string> = {
    sent: "chip-positive",
    failed: "chip-negative",
    suppressed: "chip-warning",
    pending: "chip-info",
  };

  let entries = $state<AlertDeliveryDto[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let filter = $state<"all" | AlertTriggerId>("all");
  let busyRead = $state<string | null>(null);

  /** Trigger metadata from the rules endpoint (labels + click paths). */
  let triggers = $state<AlertRulesResponse["triggers"]>([]);

  function triggerMeta(id: string) {
    return triggers.find((t) => t.id === id);
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      if (triggers.length === 0) {
        // One cheap extra call gives the inbox labels + click paths.
        const rules = await endpoints.alertsRules();
        triggers = rules.triggers;
      }
      const res: AlertDeliveriesResponse = await endpoints.alertsDeliveries({
        limit: 50,
        triggerType: filter === "all" ? null : filter,
      });
      entries = res.entries;
      nextCursor = res.nextCursor;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    loadingMore = true;
    try {
      const res = await endpoints.alertsDeliveries({
        limit: 50,
        cursor: nextCursor,
        triggerType: filter === "all" ? null : filter,
      });
      entries = [...entries, ...res.entries];
      nextCursor = res.nextCursor;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loadingMore = false;
    }
  }

  async function markRead(entry: AlertDeliveryDto): Promise<void> {
    busyRead = entry.id;
    try {
      if (entry.readAtSec === null) {
        await endpoints.alertsMarkRead(entry.id);
        entry.readAtSec = Math.floor(Date.now() / 1000);
        await refreshAlertUnread();
      }
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      busyRead = null;
    }
  }

  async function markAllRead(): Promise<void> {
    busyRead = "__all";
    try {
      await endpoints.alertsMarkAllRead();
      const nowSec = Math.floor(Date.now() / 1000);
      entries = entries.map((e) => ({ ...e, readAtSec: e.readAtSec ?? nowSec }));
      await refreshAlertUnread();
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      busyRead = null;
    }
  }

  function channelSummary(entry: AlertDeliveryDto): string | null {
    if (entry.channels.length === 0) return null;
    const parts = entry.channels.map((c) => {
      const label = c.status === "sent" ? "Discord delivered" : c.status === "failed" ? "Discord failed" : `Discord ${c.status}`;
      return c.errorMessage ? `${label}: ${c.errorMessage}` : label;
    });
    return parts.join(" · ");
  }

  $effect(() => {
    void load();
  });
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
  <div class="flex items-center gap-2">
    <label class="text-[12.5px] text-fg-muted" for="alerts-filter">Filter</label>
    <select
      id="alerts-filter"
      class="input max-w-56"
      value={filter}
      onchange={(e) => {
        filter = (e.currentTarget as HTMLSelectElement).value as typeof filter;
        void load();
      }}
    >
      <option value="all">All trigger types</option>
      {#each triggers as t (t.id)}
        <option value={t.id}>{t.label}</option>
      {/each}
    </select>
  </div>
  <button class="btn btn-sm" disabled={busyRead !== null || alertUnread.count === 0} onclick={() => void markAllRead()}>
    {busyRead === "__all" ? "Marking…" : "Mark all as read"}
  </button>
</div>

{#if loading && entries.length === 0}
  <StateMessage state="loading" title="Loading inbox" skeleton="rows" />
{:else if error && entries.length === 0}
  <StateMessage state="error" title="Could not load the inbox" hint={error} action={{ label: "Retry", run: () => void load() }} />
{:else if entries.length === 0}
  <StateMessage state="empty" title="No alerts yet" hint="Alerts appear here when an enabled rule fires. Configure rules and a Discord channel above." />
{:else}
  <div class="space-y-2.5">
    {#each entries as entry (entry.id)}
      {@const meta = triggerMeta(entry.triggerType)}
      <Panel variant={entry.readAtSec === null ? "outlined" : "quiet"}>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              {#if entry.readAtSec === null}
                <span class="h-2 w-2 shrink-0 rounded-full bg-accent" title="Unread" aria-label="Unread"></span>
              {/if}
              <a href={meta?.clickPath ?? "/today"} class="truncate text-[14px] font-semibold text-fg hover:underline underline-offset-2">
                {entry.title}
              </a>
              <span class="chip chip-quiet">{meta?.label ?? entry.triggerType}</span>
              <span class={`chip ${STATUS_TONES[entry.status]}`}>{ALERT_DELIVERY_STATUS_LABELS[entry.status]} <span class="text-fg-faint">(in-app)</span></span>
              {#each entry.channels as channel (channel.channelId)}
                <span class={`chip ${STATUS_TONES[channel.status]}`} title={channel.errorMessage ?? undefined}>
                  Discord {channel.status}
                  {#if channel.attempts > 1}<span class="text-fg-faint">· {channel.attempts} attempts</span>{/if}
                </span>
              {/each}
            </div>
            <p class="mt-1.5 text-[13px] leading-snug text-fg-muted">{entry.message}</p>
            {#if channelSummary(entry)}
              <p class="mt-1 text-[11.5px] leading-snug text-fg-faint">{channelSummary(entry)}</p>
            {/if}
            <p class="mt-1.5 text-[11.5px] text-fg-faint" title={displayDateTime(entry.occurredAtSec)}>
              {formatRelative(entry.occurredAtSec)}
              {#if entry.readAtSec !== null}· read{/if}
            </p>
          </div>
          {#if entry.readAtSec === null}
            <button class="btn btn-sm shrink-0" disabled={busyRead === entry.id} onclick={() => void markRead(entry)}>
              {busyRead === entry.id ? "…" : "Mark read"}
            </button>
          {/if}
        </div>
      </Panel>
    {/each}
  </div>
  {#if nextCursor}
    <div class="mt-4 flex justify-center">
      <button class="btn btn-sm" disabled={loadingMore} onclick={() => void loadMore()}>
        {loadingMore ? "Loading…" : "Load more"}
      </button>
    </div>
  {/if}
{/if}
