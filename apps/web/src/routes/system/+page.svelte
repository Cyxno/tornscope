<script lang="ts">
  import { onMount } from "svelte";
  import type { SystemHealthResponse } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import {
    deriveServiceRows,
    deriveSyncSummary,
    formatAgeCompact,
    freshnessChip,
    humanizeErrorKind,
    sortFreshnessWorstFirst,
  } from "$lib/system-view";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  /**
   * System health (2.0) — the operator's view of the machinery, in three
   * sections: SERVICES (what runs), SYNC (what collects) and DATA FRESHNESS
   * (how current each domain is, worst first). Mapping lives in
   * $lib/system-view (tested there); this page only renders.
   */

  let health = $state<SystemHealthResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  async function load() {
    error = null;
    try {
      health = await endpoints.systemHealth();
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
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => clearInterval(poll);
  });

  // Ages are computed against the payload's own generation time, so a slow
  // render never inflates them.
  const nowSec = $derived(health !== null ? health.generatedAt : Math.floor(Date.now() / 1000));
  const services = $derived(health !== null ? deriveServiceRows(health.services) : []);
  const sync = $derived(health !== null ? deriveSyncSummary(health.sync, nowSec) : null);
  const freshness = $derived(health !== null ? sortFreshnessWorstFirst(health.freshness) : []);
</script>

<svelte:head><title>System · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="System"
    title="System health"
    description="Whether the services behind TornScope are running, what the sync worker is doing, and how current each data domain is."
  />

  {#if loading && !health}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load system health" hint={error} action={{ label: "Retry", run: () => void load() }} />
  {:else if health}
    <p class="text-xs text-fg-faint">Checked {formatRelative(health.generatedAt)} — refreshes on its own while this page is open.</p>

    <!-- ── Services: what runs, each with a named status (never color alone) ── -->
    <section class="section-rule" aria-label="Services">
      <p class="section-label">Services</p>
      <ul class="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {#each services as row (row.key)}
          <li class="flex min-w-0 items-start gap-3 rounded-xl border border-border bg-surface px-3 py-2.5">
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-2">
                <span class="text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{row.name}</span>
                <span class={`chip ${row.chip.chip}`}>{row.chip.label}</span>
              </span>
              {#if row.detail}
                <span class="mt-0.5 block truncate text-xs text-fg-faint" title={row.detail}>{row.detail}</span>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    </section>

    <!-- ── Sync: the collector's live state ── -->
    <section class="section-rule" aria-label="Sync">
      <p class="section-label">Sync</p>
      {#if sync}
        <div class="mt-2.5 space-y-3 rounded-xl border border-border bg-surface px-4 py-3">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full {sync.running ? 'bg-accent live-dot' : 'bg-fg-faint'}" aria-hidden="true"></span>
              <span class="text-[13px] font-semibold {sync.running ? 'text-accent' : 'text-fg-muted'}">{sync.running ? "Sync running" : "Sync idle"}</span>
            </span>
            <span class="text-xs text-fg-faint">{sync.queueLine}</span>
          </div>
          <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt class="text-[10px] font-medium uppercase tracking-[0.11em] text-fg-faint">Oldest outstanding job</dt>
              <dd class="tnum mt-0.5 text-[13px] text-fg-muted">{sync.oldestOutstanding ?? "—"}</dd>
            </div>
            <div>
              <dt class="text-[10px] font-medium uppercase tracking-[0.11em] text-fg-faint">Last successful sync</dt>
              <dd class="tnum mt-0.5 text-[13px] text-fg-muted">{sync.lastSuccess}</dd>
            </div>
          </dl>
          {#if sync.failing.length > 0}
            <div>
              <p class="text-[10px] font-medium uppercase tracking-[0.11em] text-fg-faint">Failing resources</p>
              <ul class="mt-1.5 space-y-1">
                {#each sync.failing as row (row.key)}
                  <li class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[13px]">
                    <span class="font-medium text-fg">{row.name}</span>
                    <span class="text-xs {row.stateClass}">{row.stateLabel}</span>
                    {#if row.errorLabel}
                      <span class="text-xs text-fg-muted">— {row.errorLabel}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {:else}
            <p class="text-xs text-fg-faint">No failing resources — every sync is healthy.</p>
          {/if}
        </div>
      {/if}
    </section>

    <!-- ── Data freshness: every domain, worst first ── -->
    <section class="section-rule" aria-label="Data freshness">
      <p class="section-label">Data freshness</p>
      <div class="mt-2.5 rounded-xl border border-border bg-surface px-4 py-2 sm:px-5">
        <table class="tsv-table">
          <caption class="sr-only">How current each data domain is, worst first</caption>
          <thead>
            <tr>
              <th scope="col" class="font-medium">Domain</th>
              <th scope="col" class="font-medium">Status</th>
              <th scope="col" class="font-medium">Age</th>
            </tr>
          </thead>
          <tbody>
            {#each freshness as row (row.domain)}
              {@const chip = freshnessChip(row.status)}
              <tr>
                <td class="min-w-0 text-fg">
                  {row.label}
                  {#if row.lastErrorKind}
                    {@const errorLabel = humanizeErrorKind(row.lastErrorKind)}
                    {#if errorLabel}
                      <span class="mt-0.5 block max-w-[220px] text-[11px] leading-snug text-negative">{errorLabel}</span>
                    {/if}
                  {/if}
                </td>
                <td class="whitespace-nowrap"><span class={`chip ${chip.chip}`}>{chip.label}</span></td>
                <td class="tnum whitespace-nowrap text-fg-muted">
                  {#if row.live}
                    Live (on demand)
                  {:else}
                    {formatAgeCompact(row.ageSeconds)}
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="mt-3 max-w-2xl text-[11px] leading-relaxed text-fg-faint">
        Freshness compares each domain's age with its own sync cadence — a 5-minute source reads "Delayed" far sooner than a daily one.
        Stocks and Merits are fetched on demand when you open their pages, so their freshness follows Torn API availability.
      </p>
    </section>
  {/if}
</div>
