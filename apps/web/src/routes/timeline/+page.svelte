<script lang="ts">
  import type { TimelineEventDto, Paginated } from "@tornscope/shared";
  import { formatMoneyCompact } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange, me } from "$lib/state.svelte";
  import { clientPermissionMessage } from "$lib/capabilities";
  import { formatDayHeading, formatClock } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  let events = $state<Paginated<TimelineEventDto> | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);
  let typeFilter = $state("");

  async function load(reset = true) {
    if (reset) loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const result = await endpoints.timeline(range, { limit: 50, cursor: reset ? undefined : (events?.nextCursor ?? undefined), type: typeFilter || undefined });
      events = reset ? result : { items: [...(events?.items ?? []), ...result.items], nextCursor: result.nextCursor };
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
      loadingMore = false;
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

  /* Group descending items into UTC day buckets */
  const timelineBlocked = $derived.by(() => {
    const caps = me.data?.capabilities ?? null;
    // The timeline is fed by logs OR events — blocked only when both are missing.
    return caps !== null && !caps.canReadUserLogs && !caps.canReadUserEvents;
  });
  const dayGroups = $derived.by(() => {
    if (!events) return [];
    const map = new Map<number, TimelineEventDto[]>();
    for (const item of events.items) {
      const d = new Date(item.occurredAt * 1000);
      const day = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
      const list = map.get(day);
      if (list) list.push(item);
      else map.set(day, [item]);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([day, list]) => ({ day, list }));
  });

  const typeFilters = [
    { value: "", label: "Everything" },
    { value: "log", label: "Logs" },
    { value: "torn_event", label: "Events" },
  ];
</script>

<svelte:head><title>Timeline · TornScope</title></svelte:head>

<div class="space-y-10">
  <PageHeader
    eyebrow="History"
    title="Your timeline"
    description="A running journal of your player — logs and events woven into one chronological feed."
  >
    {#snippet actions()}
      <div class="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-1">
        {#each typeFilters as f (f.value)}
          <button
            class="rounded-full px-3.5 py-1.5 text-xs font-medium transition-all {typeFilter === f.value ? 'bg-fg font-semibold text-bg' : 'text-fg-muted hover:text-fg'}"
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
      action={{ label: "Review API access in Settings", run: () => (window.location.href = "/settings") }}
    />
  {:else if events && events.items.length === 0}
    <StateMessage state="empty" title="Quiet in this range" hint={me.data?.isDemo ? "Synthetic example data — the demo dataset has no timeline entries here." : "No timeline entries match. Widen the date range or wait for the next sync."} />
  {:else if events}
    <div class="space-y-10">
      {#each dayGroups as group (group.day)}
        <section>
          <h2 class="font-display text-xl font-medium text-fg-muted">{formatDayHeading(group.list[0]!.occurredAt)}</h2>
          <ol class="relative mt-4 space-y-1">
            <span class="absolute top-2 bottom-2 left-[7px] w-px bg-border"></span>
            {#each group.list as event (event.id)}
              <li class="relative flex items-start gap-4 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface/70">
                <span class="relative z-10 mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full border-2 {event.type === 'torn_event' ? 'border-warning bg-warning/25' : event.category?.toLowerCase().includes('overdos') ? 'border-negative bg-negative/25' : 'border-accent bg-accent/25'}"></span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span class="tnum text-xs text-fg-faint">{formatClock(event.occurredAt)}</span>
                    {#if event.category}
                      <span class="text-[11px] uppercase tracking-[0.1em] text-fg-faint">{event.category}</span>
                    {/if}
                  </div>
                  <p class="mt-0.5 text-sm leading-relaxed text-fg">{event.title}</p>
                  {#if event.description && event.description !== event.title}
                    <p class="mt-0.5 line-clamp-2 text-[13px] leading-relaxed text-fg-muted">{event.description}</p>
                  {/if}
                </div>
                {#if event.amount !== null && event.amount !== undefined}
                  <span class="tnum mt-0.5 shrink-0 text-sm font-medium {(event.amount ?? 0) >= 0 ? 'text-positive' : 'text-negative'}">
                    {(event.amount ?? 0) >= 0 ? '+' : ''}{formatMoneyCompact(event.amount)}
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
          <button class="rounded-full border border-border-strong px-5 py-2 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent" onclick={() => void loadMore()}>
            Load older entries
          </button>
        {/if}
      </div>
    </div>
  {/if}
</div>
