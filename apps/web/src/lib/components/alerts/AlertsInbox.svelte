<script lang="ts">
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import { displayDateTime } from "$lib/time-display.svelte";
  import { alertUnread, refreshAlertUnread } from "$lib/state.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { ALERT_DELIVERY_STATUS_LABELS } from "@tornscope/shared";
  import type {
    AlertCategory,
    AlertConfidenceLabel,
    AlertDeliveriesResponse,
    AlertDeliveryDto,
    AlertDeliveryStatus,
    AlertRuleDto,
    AlertRulesResponse,
    AlertSeverity,
    AlertTriggerId,
  } from "@tornscope/shared";

  /**
   * In-app inbox: reverse-chronological logical alerts. `status` is the
   * IN-APP delivery state; per-Discord states render as their own chips so
   * the two never blur. Cursor-based "Load more", trigger filter plus
   * client-side category/severity filters (2.10.0), per-entry provenance
   * panel, episode timeline derived from the loaded delivery ledger, and
   * per-rule snooze.
   */

  const STATUS_TONES: Record<AlertDeliveryStatus, string> = {
    sent: "chip-positive",
    failed: "chip-negative",
    suppressed: "chip-warning",
    pending: "chip-info",
    deferred: "chip-warning",
  };

  const SEVERITY_TONES: Record<AlertSeverity, string> = {
    info: "chip-info",
    warning: "chip-warning",
    critical: "chip-negative",
  };

  const CONFIDENCE_TONES: Record<AlertConfidenceLabel, string> = {
    exact: "chip-positive",
    derived: "chip-info",
    estimated: "chip-warning",
    inferred: "chip-quiet",
  };

  const CATEGORY_LABELS: Record<AlertCategory, string> = {
    economy: "Economy",
    progression: "Progression",
    health: "Health",
    travel: "Travel",
    combat: "Combat",
    operational: "Operational",
  };

  const SNOOZE_24H_SECONDS = 24 * 3600;

  let entries = $state<AlertDeliveryDto[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let filter = $state<"all" | AlertTriggerId>("all");
  let categoryFilter = $state<"all" | AlertCategory>("all");
  let severityFilter = $state<"all" | AlertSeverity>("all");
  let busyRead = $state<string | null>(null);
  let busySnooze = $state<string | null>(null);
  let expanded = $state<string | null>(null);

  /** Trigger metadata + rule rows (snooze state) from the rules endpoint. */
  let triggers = $state<AlertRulesResponse["triggers"]>([]);
  let rules = $state<AlertRuleDto[]>([]);

  function triggerMeta(id: string) {
    return triggers.find((t) => t.id === id);
  }

  function ruleFor(entry: AlertDeliveryDto): AlertRuleDto | undefined {
    return rules.find((r) => r.id === entry.ruleId);
  }

  function isSnoozed(rule: AlertRuleDto | undefined): boolean {
    if (!rule || rule.snoozedUntilSec === null) return false;
    return rule.snoozedUntilSec > Math.floor(Date.now() / 1000);
  }

  /** Client-side view over the loaded page — category/severity filter only. */
  let visibleEntries = $derived(
    entries.filter((entry) => {
      const meta = triggerMeta(entry.triggerType);
      if (categoryFilter !== "all" && meta?.category !== categoryFilter) return false;
      if (severityFilter !== "all" && meta?.severity !== severityFilter) return false;
      return true;
    })
  );

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      if (triggers.length === 0) {
        // One cheap extra call gives the inbox labels, click paths, rules
        // (snooze state) and the 2.10.0 category/severity metadata.
        const res = await endpoints.alertsRules();
        triggers = res.triggers;
        rules = res.rules;
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

  async function snooze24h(entry: AlertDeliveryDto): Promise<void> {
    const rule = ruleFor(entry);
    if (!rule) return;
    busySnooze = entry.id;
    error = null;
    try {
      const untilSec = Math.floor(Date.now() / 1000) + SNOOZE_24H_SECONDS;
      const updated = await endpoints.alertsSnoozeRule(rule.id, untilSec);
      rules = rules.map((r) => (r.id === updated.id ? updated : r));
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      busySnooze = null;
    }
  }

  async function unsnooze(entry: AlertDeliveryDto): Promise<void> {
    const rule = ruleFor(entry);
    if (!rule) return;
    busySnooze = entry.id;
    error = null;
    try {
      const updated = await endpoints.alertsSnoozeRule(rule.id, null);
      rules = rules.map((r) => (r.id === updated.id ? updated : r));
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      busySnooze = null;
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

  function payloadLines(entry: AlertDeliveryDto): Array<[string, string]> {
    if (!entry.payload) return [];
    return Object.entries(entry.payload).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
  }

  $effect(() => {
    void load();
  });
</script>

<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
  <div class="flex flex-wrap items-center gap-2">
    <label class="text-[12.5px] text-fg-muted" for="alerts-filter">Trigger</label>
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
    <label class="text-[12.5px] text-fg-muted" for="alerts-category">Category</label>
    <select
      id="alerts-category"
      class="input max-w-40"
      value={categoryFilter}
      onchange={(e) => {
        categoryFilter = (e.currentTarget as HTMLSelectElement).value as typeof categoryFilter;
      }}
    >
      <option value="all">All categories</option>
      {#each Object.entries(CATEGORY_LABELS) as [value, label] (value)}
        <option {value}>{label}</option>
      {/each}
    </select>
    <label class="text-[12.5px] text-fg-muted" for="alerts-severity">Severity</label>
    <select
      id="alerts-severity"
      class="input max-w-36"
      value={severityFilter}
      onchange={(e) => {
        severityFilter = (e.currentTarget as HTMLSelectElement).value as typeof severityFilter;
      }}
    >
      <option value="all">All severities</option>
      <option value="critical">Critical</option>
      <option value="warning">Warning</option>
      <option value="info">Info</option>
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
{:else if visibleEntries.length === 0}
  <StateMessage
    state="empty"
    title={entries.length === 0 ? "No alerts yet" : "No alerts match the filters"}
    hint={entries.length === 0 ? "Alerts appear here when an enabled rule fires. Configure rules and a Discord channel above." : "Loosen the category or severity filter."}
  />
{:else}
  <div class="space-y-2.5">
    {#each visibleEntries as entry (entry.id)}
      {@const meta = triggerMeta(entry.triggerType)}
      {@const rule = ruleFor(entry)}
      {@const snoozed = isSnoozed(rule)}
      {@const open = expanded === entry.id}
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
              {#if meta}
                <span class={`chip ${SEVERITY_TONES[meta.severity]}`}>{meta.severity}</span>
                <span class="chip chip-quiet">{CATEGORY_LABELS[meta.category]}</span>
              {/if}
              {#if snoozed}
                <span class="chip chip-warning" title={rule && rule.snoozedUntilSec !== null ? `Snoozed until ${displayDateTime(rule.snoozedUntilSec)}` : undefined}>
                  Snoozed{rule?.snoozedUntilSec ? ` · ${formatRelative(rule.snoozedUntilSec)}` : ""}
                </span>
              {/if}
              <span class={`chip ${STATUS_TONES[entry.status]}`} title={entry.status === "deferred" && entry.deferredUntilSec !== null ? `Deferred until ${displayDateTime(entry.deferredUntilSec)} (rule quiet hours)` : undefined}>
                {ALERT_DELIVERY_STATUS_LABELS[entry.status]}
                {#if entry.status === "deferred" && entry.deferredUntilSec !== null}
                  <span class="text-fg-faint">until {formatRelative(entry.deferredUntilSec)}</span>
                {:else}
                  <span class="text-fg-faint">(in-app)</span>
                {/if}
              </span>
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
          <div class="flex shrink-0 flex-col items-end gap-1.5">
            {#if entry.readAtSec === null}
              <button class="btn btn-sm" disabled={busyRead === entry.id} onclick={() => void markRead(entry)}>
                {busyRead === entry.id ? "…" : "Mark read"}
              </button>
            {/if}
            {#if rule}
              {#if snoozed}
                <button class="btn btn-sm" disabled={busySnooze === entry.id} onclick={() => void unsnooze(entry)}>
                  {busySnooze === entry.id ? "…" : "Unsnooze"}
                </button>
              {:else}
                <button class="btn btn-sm" disabled={busySnooze === entry.id} title="Silence this rule for 24h — episode memory is kept" onclick={() => void snooze24h(entry)}>
                  {busySnooze === entry.id ? "…" : "Snooze 24h"}
                </button>
              {/if}
            {/if}
            <button class="btn btn-sm" aria-expanded={open} onclick={() => (expanded = open ? null : entry.id)}>
              {open ? "Hide details" : "Details"}
            </button>
          </div>
        </div>

        {#if open}
          {@const episode = entries
            .filter((e) => e.triggerType === entry.triggerType)
            .slice()
            .sort((a, b) => b.occurredAtSec - a.occurredAtSec)
            .slice(0, 10)}
          <div class="mt-3 border-t border-edge pt-3">
            {#if entry.provenance}
              {@const prov = entry.provenance}
              <div class="text-[12px] font-semibold text-fg-muted">Where this fact came from</div>
              <div class="mt-1.5 flex flex-wrap items-center gap-2">
                <span class={`chip ${CONFIDENCE_TONES[prov.confidence]}`}>confidence: {prov.confidence}</span>
                {#each prov.sources as source (source)}
                  <span class="chip chip-quiet">{source}</span>
                {/each}
                {#if prov.window}
                  <span class="chip chip-quiet" title="Observed window">
                    {displayDateTime(prov.window.fromSec)} → {displayDateTime(prov.window.toSec)}
                  </span>
                {/if}
              </div>
              {#if prov.note}
                <p class="mt-1.5 text-[12px] leading-snug text-fg-muted">{prov.note}</p>
              {/if}
            {:else}
              <p class="mt-1 text-[12px] text-fg-faint">Provenance unavailable — this alert was committed before 2.10.0.</p>
            {/if}

            {#if payloadLines(entry).length > 0}
              <div class="mt-3 text-[12px] font-semibold text-fg-muted">Payload</div>
              <dl class="mt-1 space-y-0.5">
                {#each payloadLines(entry) as [key, value] (key)}
                  <div class="flex gap-2 text-[12px]">
                    <dt class="shrink-0 text-fg-faint">{key}</dt>
                    <dd class="min-w-0 break-words text-fg-muted">{value}</dd>
                  </div>
                {/each}
              </dl>
            {/if}

            {#if episode.length > 1}
              <div class="mt-3 text-[12px] font-semibold text-fg-muted">Episode — recent {entry.triggerType} alerts (loaded ledger)</div>
              <ul class="mt-1 space-y-0.5">
                {#each episode as row (row.id)}
                  <li class="flex items-center gap-2 text-[12px]">
                    <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${row.readAtSec === null ? "bg-accent" : "bg-edge"}`}></span>
                    <span class={row.id === entry.id ? "font-semibold text-fg" : "text-fg-muted"}>{row.title}</span>
                    <span class="text-fg-faint" title={displayDateTime(row.occurredAtSec)}>{formatRelative(row.occurredAtSec)}</span>
                    {#if row.id === entry.id}<span class="chip chip-quiet">this</span>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
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
