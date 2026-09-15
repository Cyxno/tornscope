<script lang="ts">
  import { createLoadGuard } from "$lib/loadGuard";
  import { goto } from "$app/navigation";
  import type { TimelineEventDto, Paginated } from "@tornscope/shared";
  import { dayKeyInZone, formatMoneyCompact } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange, me } from "$lib/state.svelte";
  import { clientPermissionMessage } from "$lib/capabilities";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import Icon, { type IconName } from "$lib/components/Icon.svelte";
  import * as td from "$lib/time-display.svelte.js";

  /** Coarse event → icon mapping: supports scanning, never decoration. */
  function eventIcon(event: TimelineEventDto): IconName {
    const cat = (event.category ?? "").toLowerCase();
    if (event.type === "torn_event") return "alert";
    if (cat.includes("overdos")) return "alert";
    if (cat.includes("money")) return "wallet";
    if (cat.includes("faction") || cat.includes("organized")) return "faction";
    if (cat.includes("crim") || cat.includes("jail")) return "crimes";
    if (cat.includes("attack") || cat.includes("combat")) return "combat";
    if (cat.includes("travel") || cat.includes("flight") || cat.includes("abroad")) return "travel";
    if (cat.includes("stock") || cat.includes("trade") || cat.includes("bazaar") || cat.includes("auction") || cat.includes("item")) return "economy";
    if (cat.includes("drug") || cat.includes("rehab") || cat.includes("medical")) return "drugs";
    return "clock";
  }

  /**
   * Torn log categories arrive as coded titles ("0234 MONEY TRADING").
   * Strip the numeric code and title-case the words — the title line stays
   * the precise record, this is just a quiet context tag.
   */
  function categoryLabel(raw: string): string {
    return raw
      .replace(/^\d+\s+/, "")
      .toLowerCase()
      // snake_case categories ("money_points") read as machine codes once
      // the chip's CSS uppercases them — humanize to "Money Points".
      .replace(/[_-]+/g, " ")
      .replace(/(^|\s)\S/g, (m) => m.toUpperCase());
  }

  let events = $state<Paginated<TimelineEventDto> | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);
  let typeFilter = $state("");

  const guard = createLoadGuard();
  async function load(reset = true) {
    const seq = guard.begin();
    if (reset) loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const result = await endpoints.timeline(range, { limit: 50, cursor: reset ? undefined : (events?.nextCursor ?? undefined), type: typeFilter || undefined });
      if (!guard.isCurrent(seq)) return; // a newer range/type superseded this response
      events = reset ? result : { items: [...(events?.items ?? []), ...result.items], nextCursor: result.nextCursor };
    } catch (err) {
      if (!guard.isCurrent(seq)) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      if (guard.isCurrent(seq)) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  async function loadMore() {
    if (!events?.nextCursor) return;
    loadingMore = true;
    await load(false);
  }

  $effect(() => {
    void dateRange.preset;
    void dateRange.from;
    void reloadToken;
    void typeFilter;
    void load(true);
  });

  /* Group descending items into day buckets keyed in the DISPLAY zone, so a
     sticky heading always names the day its rows actually show. (The old
     UTC bucketing under a display-zone heading mislabeled rows near
     midnight in local mode; analytics grouping is unaffected — this feed
     is presentation.) */
  const timelineBlocked = $derived.by(() => {
    const caps = me.data?.capabilities ?? null;
    // The timeline is fed by logs OR events — blocked only when both are missing.
    return caps !== null && !caps.canReadUserLogs && !caps.canReadUserEvents;
  });
  const dayGroups = $derived.by(() => {
    if (!events) return [];
    const zone = td.displayTimeZone();
    const map = new Map<string, TimelineEventDto[]>();
    for (const item of events.items) {
      const key = dayKeyInZone(item.occurredAt, zone);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()]
      .sort((a, b) => b[1][0]!.occurredAt - a[1][0]!.occurredAt)
      .map(([key, list]) => ({ key, list }));
  });

  const typeFilters = [
    { value: "", label: "Everything" },
    { value: "log", label: "Logs" },
    { value: "torn_event", label: "Events" },
  ];
</script>

<svelte:head><title>Timeline · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="History"
    title="Your timeline"
    description="A running journal of your player — logs and events woven into one chronological feed."
  >
    {#snippet actions()}
      <div class="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-1">
        {#each typeFilters as f (f.value)}
          <button
            class="rounded-full px-3 py-1 text-xs font-medium transition-all {typeFilter === f.value ? 'bg-fg font-semibold text-bg' : 'text-fg-muted hover:text-fg'}"
            onclick={() => (typeFilter = f.value)}
          >
            {f.label}
          </button>
        {/each}
      </div>
    {/snippet}
  </PageHeader>

  {#if loading && !events}
    <StateMessage state="loading" />
  {:else if error && !events}
    <StateMessage state="error" title="Could not load your timeline" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if events && timelineBlocked}
    <StateMessage
      state="permission"
      title="Timeline unavailable with current API permissions"
      hint="Your current API key provides neither User Logs nor User Events — grant either in Torn to build your timeline."
      action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
    />
  {:else if events && events.items.length === 0}
    <StateMessage state="empty" title="Quiet in this range" hint={me.data?.isDemo ? "Synthetic example data — the demo dataset has no timeline entries here." : "No timeline entries match. Widen the date range or wait for the next sync."} />
  {:else if events}
    <div class="space-y-8">
      {#each dayGroups as group (group.key)}
        <section>
          <!-- Date anchor: sticky, the ledger's section rule -->
          <h2 class="section-label sticky top-0 z-10 -mx-2 border-b border-border bg-bg/90 px-2 py-2 backdrop-blur-sm">{td.displayDayHeading(group.list[0]!.occurredAt)}</h2>
          <ol>
            {#each group.list as event (event.id)}
              <li class="grid grid-cols-[44px_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-border/40 px-2 py-2 transition-colors last:border-0 hover:bg-surface/60">
                <span class="tnum text-right text-[11px] text-fg-faint">{td.displayTime(event.occurredAt)}</span>
                <span class="min-w-0 truncate text-[13px] text-fg" title={event.title}>
                  <Icon
                    name={eventIcon(event)}
                    size={11}
                    class="mr-1.5 inline {event.type === 'torn_event'
                      ? 'text-warning'
                      : event.category?.toLowerCase().includes('overdos')
                        ? 'text-negative'
                        : 'text-fg-faint'}"
                  />
                  {event.title}
                  {#if event.category}
                    <span class="ml-2 text-[10px] font-medium uppercase tracking-[0.1em] text-fg-faint">{categoryLabel(event.category)}</span>
                  {/if}
                  {#if event.description && event.description !== event.title}
                    <span class="hidden text-xs text-fg-faint lg:inline"> — {event.description}</span>
                  {/if}
                </span>
                {#if event.amount !== null && event.amount !== undefined}
                  <span class="tnum text-right text-[13px] font-medium {event.amount >= 0 ? 'text-positive' : 'text-negative'}">
                    {event.amount >= 0 ? '+' : ''}{formatMoneyCompact(event.amount)}
                  </span>
                {/if}
              </li>
            {/each}
          </ol>
        </section>
      {/each}

      <div class="flex justify-center">
        {#if loadingMore}
          <div class="h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-accent"></div>
        {:else if events.nextCursor}
          <button class="btn" onclick={() => void loadMore()}>
            Load older entries
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
