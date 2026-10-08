<script lang="ts">
  import type { LogEventDto, LogsMetaResponse, LogsResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatNumberCompact } from "@tornscope/shared";
  import { createLoadGuard } from "$lib/loadGuard";
  import { endpoints, deepAnalytics, type LogsQuery, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import * as td from "$lib/time-display.svelte.js";

  let data = $state<LogsResponse | null>(null);
  let meta = $state<LogsMetaResponse | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const LIMIT = 50;

  let category = $state("");
  let type = $state("");
  let search = $state("");
  let outcome = $state<"" | "gain" | "loss">("");
  let minAmount = $state("");
  let maxAmount = $state("");

  function filters(): LogsQuery {
    return {
      category: category || undefined,
      type: type || undefined,
      search: search.trim() || undefined,
      outcome: outcome || undefined,
      minAmount: minAmount.trim() || undefined,
      maxAmount: maxAmount.trim() || undefined,
    };
  }

  let activeFilters = $state<LogsQuery>({});

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const query = filters();
      const [res, m] = await Promise.all([deepAnalytics.logs(range, query, LIMIT), deepAnalytics.logsMeta(range)]);
      if (!guard.isCurrent(seq)) return;
      data = res;
      meta = m;
      activeFilters = query;
    } catch (err) {
      if (!guard.isCurrent(seq)) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      if (guard.isCurrent(seq)) loading = false;
    }
  }

  async function loadMore() {
    if (!data?.nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      const res = await deepAnalytics.logs({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to }, activeFilters, LIMIT, data.nextCursor);
      data = { ...res, items: [...data.items, ...res.items] };
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    void dateRange.preset;
    void dateRange.from;
    void reloadToken;
    void load();
  });

  let searchDebounce = $state<ReturnType<typeof setTimeout> | null>(null);
  function onSearchInput() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => (reloadToken += 1), 400);
  }

  function applyFilters() {
    reloadToken += 1;
  }

  const titlesForCategory = $derived.by(() => {
    // The archive meta caps titles by frequency; the select mirrors the
    // server's own ordering (most-used first).
    return (meta?.titles ?? []).slice(0, 200);
  });

  const moneyCell = (v: number | null): string => {
    if (v === null) return "";
    return v < 0 ? `-${formatMoneyCompact(-v).replace("-", "")}` : `+${formatMoneyCompact(v)}`;
  };

  let expanded = $state<string | null>(null);
  function toggle(id: string) {
    expanded = expanded === id ? null : id;
  }

  function exportUrl(format: "csv" | "json"): string {
    return deepAnalytics.logsExportUrl({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to }, activeFilters, format);
  }
</script>

<svelte:head><title>Logs · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Personal · Deep analytics"
    title="Log explorer"
    description="Your full stored Torn log archive, filterable and exportable — read entirely from TornScope's own database."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  <!-- Filters -->
  <Panel flush bodyClass="p-4 sm:p-5">
    <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
      <label class="block">
        <span class="section-label">Category</span>
        <select class="input mt-1 w-full" bind:value={category} onchange={applyFilters}>
          <option value="">All categories</option>
          {#each meta?.categories ?? [] as c (c.category)}
            <option value={c.category}>{c.category} ({c.count})</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="section-label">Type</span>
        <select class="input mt-1 w-full" bind:value={type} onchange={applyFilters}>
          <option value="">All types</option>
          {#each titlesForCategory as t (t.title)}
            <option value={t.title}>{t.title}</option>
          {/each}
        </select>
      </label>
      <label class="block">
        <span class="section-label">Search</span>
        <input class="input mt-1 w-full" type="search" placeholder="Search titles and categories…" bind:value={search} oninput={onSearchInput} />
      </label>
    </div>
    <div class="mt-3 grid gap-3 md:grid-cols-[auto_auto_auto_1fr] md:items-end">
      <label class="block">
        <span class="section-label">Money</span>
        <select class="input mt-1 w-full" bind:value={outcome} onchange={applyFilters}>
          <option value="">Any</option>
          <option value="gain">Gains only</option>
          <option value="loss">Losses only</option>
        </select>
      </label>
      <label class="block">
        <span class="section-label">Min |amount|</span>
        <input class="input mt-1 w-full md:w-32" type="number" min="0" placeholder="—" bind:value={minAmount} onchange={applyFilters} />
      </label>
      <label class="block">
        <span class="section-label">Max |amount|</span>
        <input class="input mt-1 w-full md:w-32" type="number" min="0" placeholder="—" bind:value={maxAmount} onchange={applyFilters} />
      </label>
      <div class="flex justify-end gap-2">
        <a class="btn btn-sm" href={exportUrl("csv")} download aria-label="Export filtered logs as CSV">
          <Icon name="external" size={14} /> CSV
        </a>
        <a class="btn btn-sm" href={exportUrl("json")} download aria-label="Export filtered logs as JSON">
          <Icon name="external" size={14} /> JSON
        </a>
      </div>
    </div>
  </Panel>

  {#if loading && !data}
    <StateMessage state="loading" skeleton="rows" />
  {:else if error}
    <StateMessage state="error" title="Could not load logs" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    {#if meta}
      <p class="text-xs text-fg-faint">
        {formatNumberCompact(meta.totalLogs)} stored log{meta.totalLogs === 1 ? "" : "s"} in range{meta.oldestAt ? ` · archive reaches back to ${td.displayDate(meta.oldestAt)}` : ""}
        · exports stream server-side (max 50,000 rows) and contain only your own data
      </p>
    {/if}

    {#if data.items.length === 0}
      <StateMessage state="empty" title="No logs match these filters" hint="Widen the date range or clear a filter." />
    {:else}
      <Panel flush>
        <div class="overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Category</th>
                <th>Type</th>
                <th class="hidden md:table-cell">Summary</th>
                <th class="text-right">Money</th>
                <th class="text-right">Energy</th>
                <th class="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {#each data.items as log (log.id)}
                {@const isOpen = expanded === log.id}
                <tr class="cursor-pointer" onclick={() => toggle(log.id)}>
                  <td class="tnum whitespace-nowrap text-fg-muted" title={td.displayDateTime(log.occurredAt)}>{td.displayDate(log.occurredAt)}</td>
                  <td class="whitespace-nowrap text-fg-muted">{log.category ?? "—"}</td>
                  <td class="max-w-[220px] truncate font-medium text-fg" title={log.title}>{log.title}</td>
                  <td class="hidden max-w-[280px] truncate text-fg-muted md:table-cell">{log.summary ?? ""}</td>
                  <td class="tnum whitespace-nowrap text-right font-medium {log.money === null ? 'text-fg-faint' : log.money < 0 ? 'text-negative' : 'text-positive'}">
                    {log.money !== null ? moneyCell(log.money) : "—"}
                  </td>
                  <td class="tnum whitespace-nowrap text-right text-fg-muted">
                    {#if log.energy !== null}{log.energy > 0 ? "+" : "−"}{formatNumberCompact(Math.abs(log.energy))} E{:else}—{/if}
                  </td>
                  <td class="text-center">
                    <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={13} class="text-fg-faint" />
                  </td>
                </tr>
                {#if isOpen}
                  <tr class="bg-surface-2/40">
                    <td colspan="7">
                      <div class="px-2 py-3">
                        <p class="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-faint">Payload digest</p>
                        <dl class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
                          {#each log.details as d (d.key)}
                            <div class="flex min-w-0 items-baseline justify-between gap-3">
                              <dt class="shrink-0 text-[11px] text-fg-faint">{d.key}</dt>
                              <dd class="tnum truncate text-[12.5px] text-fg" title={d.value}>{d.value}</dd>
                            </div>
                          {/each}
                          {#if log.details.length === 0}
                            <dd class="text-[12px] text-fg-faint">No structured payload keys on this log.</dd>
                          {/if}
                        </dl>
                        <p class="mt-2 text-[11px] text-fg-faint">
                          Exact Torn record · id {log.id} · {td.displayDateTime(log.occurredAt)}
                        </p>
                      </div>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        {#if data.nextCursor}
          <div class="border-t border-border p-4 text-center">
            <button class="btn btn-sm cursor-pointer" onclick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : `Load 50 more`}
            </button>
          </div>
        {/if}
      </Panel>
    {/if}
  {/if}
</div>
