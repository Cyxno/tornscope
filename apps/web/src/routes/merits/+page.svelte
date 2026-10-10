<script lang="ts">
  import { goto } from "$app/navigation";
  import type { MeritsResponse, MeritRowDto, FeatureAvailability as FeatureAvailabilityDto, AccountEffect } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import Icon from "$lib/components/Icon.svelte";

  /**
   * Merits — "a structured account progression ledger".
   *
   * Ranks are exact API values; caps and categories are TornScope-maintained
   * metadata (Torn's API publishes neither), so a merit without a maintained
   * cap renders "Level N" and is never claimed maxed. Sources and semantics:
   * docs/MERITS.md.
   */

  let data = $state<MeritsResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  // URL state: shareable filter/category/search (?filter=&category=&q=).
  let filter = $state<"all" | "owned" | "partial" | "maxed" | "unowned">("all");
  let category = $state<string>("");
  let query = $state<string>("");
  let expandedId = $state<number | null>(null);
  let loadSeq = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    const f = params.get("filter");
    if (f === "owned" || f === "partial" || f === "maxed" || f === "unowned") filter = f;
    const c = params.get("category");
    if (c) category = c;
    const q = params.get("q");
    if (q) query = q;
  });

  function syncUrl() {
    const url = new URL(window.location.href);
    if (filter !== "all") url.searchParams.set("filter", filter);
    else url.searchParams.delete("filter");
    if (category) url.searchParams.set("category", category);
    else url.searchParams.delete("category");
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
  }

  async function load() {
    const seq = ++loadSeq;
    loading = true;
    error = null;
    try {
      const res = await endpoints.merits();
      if (seq !== loadSeq) return;
      data = res;
    } catch (err) {
      if (seq !== loadSeq) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      data = null;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  $effect(() => {
    void reloadToken;
    void load();
  });

  const filtered = $derived.by(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.merits.filter((row) => {
      if (filter === "owned" && !row.owned) return false;
      if (filter === "partial" && row.state !== "partial") return false;
      if (filter === "maxed" && row.state !== "maxed") return false;
      if (filter === "unowned" && row.owned) return false;
      if (category && row.category !== category) return false;
      if (q && !`${row.name ?? ""} ${row.description ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  const categories = $derived.by(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const row of data.merits) if (row.category) set.add(row.category);
    return [...set].sort();
  });

  function setFilter(next: typeof filter) {
    filter = next;
    syncUrl();
  }
  function setCategory(next: string) {
    category = next;
    syncUrl();
  }
  function onSearchInput(value: string) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      query = value;
      syncUrl();
    }, 250);
  }

  function stateLabel(row: MeritRowDto): string {
    if (row.catalogMismatch) return "catalog out of date";
    if (row.state === "maxed") return "Maxed";
    if (row.state === "partial") return "Partial";
    if (row.state === "owned") return "Invested";
    return "Untouched";
  }

  function availabilityState(a: FeatureAvailabilityDto): "permission" | "loading" {
    return a.state === "unavailable_permission" || a.state === "stale_permission" ? "permission" : "loading";
  }

  // Current effects (2.8.4): rendered from the combined account-effect rows so
  // merit and education contributions of the same family appear once, with
  // percent / flat / special kept visually apart within each group.
  const UNIT_ORDER = { percent: 0, flat: 1, special: 2 } as const;
  function rowUnit(effect: AccountEffect): "percent" | "flat" | "special" {
    return effect.merit?.unit ?? effect.education?.unit ?? "special";
  }
  const effectGroups = $derived.by(() => {
    const rows = data?.accountEffects ?? [];
    const groups = new Map<string, AccountEffect[]>();
    for (const row of rows) {
      const list = groups.get(row.group) ?? [];
      list.push(row);
      groups.set(row.group, list);
    }
    return [...groups.entries()]
      .map(([group, items]) => [
        group,
        items.sort((a, b) => UNIT_ORDER[rowUnit(a)] - UNIT_ORDER[rowUnit(b)] || a.label.localeCompare(b.label)),
      ] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  });
  const unknownEducation = $derived(data?.unknownEducationEffects ?? []);
</script>

<svelte:head><title>Merits · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Account · Progression"
    title="Merits"
    description="Where your merit points are invested — ranks are exact from Torn; caps come from TornScope's maintained catalog."
  >
    {#snippet actions()}
      <label class="flex items-center gap-2 text-xs text-fg-muted">
        <span class="sr-only">Search merits</span>
        <input
          type="search"
          placeholder="Search merits"
          aria-label="Search merits"
          class="input !h-9 w-44"
          value={query}
          oninput={(e) => onSearchInput((e.currentTarget as HTMLInputElement).value)}
        />
      </label>
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load merits" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data && data.availability.state !== "available_live" && data.availability.state !== "available_historical"}
    <StateMessage
      state={availabilityState(data.availability)}
      title={data.availability.state === "unavailable_permission" || data.availability.state === "stale_permission" ? "Merits need additional Torn API access" : "Merit data unavailable"}
      hint="Grant the merits selection on your Torn API key, then review access in Settings."
      action={{ label: "Review API access in Settings", run: () => void goto("/settings") }}
    />
  {:else if data}
    {#if data.summary.available !== null}
      <p class="max-w-3xl font-display text-lg leading-relaxed text-fg sm:text-xl">
        {#if data.summary.available > 0}
          <span class="tnum font-semibold text-accent">{data.summary.available} merit point{data.summary.available === 1 ? "" : "s"}</span>
          unspent — <span class="tnum">{data.summary.used}</span> already invested across <span class="tnum">{data.summary.ownedCount}</span> merit{data.summary.ownedCount === 1 ? "" : "s"}.
        {:else}
          All <span class="tnum font-semibold">{data.summary.used}</span> merit points are invested across <span class="tnum">{data.summary.ownedCount}</span> merit{data.summary.ownedCount === 1 ? "" : "s"}.
        {/if}
        {#if data.summary.medals !== null}
          <span class="text-fg-muted">Earned {data.summary.medals} medal{data.summary.medals === 1 ? "" : "s"} and {data.summary.honors ?? 0} honor{data.summary.honors === 1 ? "" : "s"} — each grants a point.</span>
        {/if}
      </p>
    {:else}
      <p class="max-w-3xl font-display text-lg leading-relaxed text-fg sm:text-xl">
        <span class="tnum font-semibold">{data.summary.used}</span> merit points invested across <span class="tnum">{data.summary.ownedCount}</span> merit{data.summary.ownedCount === 1 ? "" : "s"}.
      </p>
    {/if}

    {#if data.accountEffects.length > 0 || unknownEducation.length > 0}
      <section aria-label="Current effects" class="overflow-hidden rounded-card border border-accent/30 bg-accent/[0.04] p-5">
        <p class="section-label">Current effects — what your account bonuses do right now</p>
        {#each effectGroups as [group, rows] (group)}
          <div class="mt-3 first:mt-2">
            <p class="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint">{group}</p>
            <ul class="mt-1.5 grid gap-x-8 gap-y-2 text-[13px] md:grid-cols-2">
              {#each rows as effect (effect.key)}
                <li class="flex items-baseline justify-between gap-3">
                  <span class="min-w-0 truncate text-fg-muted">
                    {effect.label}
                    {#if effect.merit?.unit === "special"}<span class="text-fg-faint"> · {effect.merit.appliesTo}</span>{/if}
                    {#if effect.merit}<span class="text-fg-faint"> · rank {effect.merit.level}</span>{/if}
                    {#if effect.education}<span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">Education</span>{/if}
                  </span>
                  <span class="tnum shrink-0 text-right">
                    {#if effect.merit}
                      <span class={`font-semibold ${effect.merit.direction === "increase" ? "text-positive" : "text-accent"}`}>
                        {effect.merit.direction === "reduce" ? "−" : "+"}{effect.merit.total}{effect.merit.unit === "percent" ? "%" : ""}
                      </span>
                      {#if effect.merit.unit !== "percent"}<span class="text-[11px] font-normal text-fg-faint">{effect.merit.unit === "special" ? "per rank" : "flat"}</span>{/if}
                    {/if}
                    {#if effect.education}
                      <span class="font-semibold text-positive">+{effect.education.total}{effect.education.unit === "percent" ? "%" : ""}</span>
                      <span class="text-[11px] font-normal text-fg-faint">courses ({effect.education.courses})</span>
                    {/if}
                  </span>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
        {#if unknownEducation.length > 0}
          <ul class="mt-3 space-y-1 border-t border-border/60 pt-2.5 text-[12px] text-fg-muted">
            {#each unknownEducation as text (text)}
              <li class="flex items-baseline justify-between gap-3">
                <span class="min-w-0">{text}</span>
                <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">Education · not quantified</span>
              </li>
            {/each}
          </ul>
        {/if}
        <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
          Merit figures are exact from your ranks and Torn's official descriptions (per-rank formulas, anchor-verified). Where a completed education course states the same family, it is listed on the same row from its own source — never summed together. Effects that cannot be stated reliably stay in the ledger below only.
        </p>
      </section>
    {/if}

    <section aria-label="Category concentration" class="space-y-2">
      <p class="section-label">Where points are concentrated</p>
      <div class="space-y-1.5">
        {#each data.summary.byCategory as cat (cat.category)}
          {@const share = data.summary.used > 0 ? (cat.points / data.summary.used) * 100 : 0}
          <div class="flex items-center gap-3 text-[13px]">
            <span class="w-36 shrink-0 truncate text-fg-muted">{cat.category}</span>
            <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div class="h-full rounded-full bg-accent/70" style={`width:${share}%`}></div>
            </div>
            <span class="tnum w-16 text-right text-fg-faint">{cat.points} pts</span>
          </div>
        {/each}
      </div>
      {#if data.summary.capUnknownCount > 0}
        <p class="pt-1 text-[11px] leading-relaxed text-fg-faint">
          Torn's API doesn't publish merit caps — {data.summary.capUnknownCount} invested merit{data.summary.capUnknownCount === 1 ? "" : "s"} render as level-only
          ({data.summary.maxedCount} verifiably maxed). Caps come from TornScope's maintained catalog.
        </p>
      {/if}
    </section>

    <!-- Filters: chips + category select, all reflected in the URL -->
    <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Filter merits">
      {#each [["all", "All"], ["owned", "Owned"], ["partial", "Partial"], ["maxed", "Maxed"], ["unowned", "Not owned"]] as [value, label] (value)}
        <button
          class="chip cursor-pointer {filter === value ? 'chip-accent font-semibold' : 'chip-quiet'}"
          aria-pressed={filter === value}
          onclick={() => setFilter(value as typeof filter)}
        >
          {label}
        </button>
      {/each}
      <label class="ml-auto flex items-center gap-1.5 text-xs text-fg-faint">
        <span class="sr-only">Filter by category</span>
        <select class="input !h-8 !w-auto py-0 text-xs" value={category} onchange={(e) => setCategory((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">All categories</option>
          {#each categories as cat (cat)}
            <option value={cat}>{cat}</option>
          {/each}
        </select>
      </label>
    </div>

    <section aria-label="Merit ledger">
      {#if filtered.length === 0}
        <StateMessage state="empty" compact title="No merits match this filter" hint="Adjust the filter, category or search to see the rest of the ledger." />
      {:else}
        <div class="overflow-hidden rounded-card border border-border bg-surface shadow-panel">
          <ul class="divide-y divide-border/60">
            {#each filtered as row (row.id)}
              <li>
                <button
                  type="button"
                  class="group flex w-full flex-col gap-2 px-4 py-3.5 text-left transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
                  aria-expanded={expandedId === row.id}
                  onclick={() => (expandedId = expandedId === row.id ? null : row.id)}
                >
                  <span class="min-w-0 flex-1">
                    <span class="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <span class="text-[14px] font-medium text-fg">{row.name ?? `Merit #${row.id}`}</span>
                      <span class="text-[10px] uppercase tracking-wide {row.owned ? 'text-fg-faint' : 'text-fg-faint/70'}">{row.category ?? "Uncategorized"}</span>
                      {#if row.state === "maxed"}
                        <span class="chip chip-positive !px-1.5 !text-[9px] !uppercase">Maxed</span>
                      {:else if row.state === "partial"}
                        <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">Partial</span>
                      {:else if row.catalogMismatch}
                        <span class="chip chip-warning !px-1.5 !text-[9px] !uppercase">Catalog?</span>
                      {/if}
                    </span>
                    {#if row.description}
                      <span class="mt-0.5 line-clamp-1 block text-xs leading-relaxed text-fg-faint">{row.description}</span>
                    {/if}
                  </span>
                  <span class="flex shrink-0 items-center gap-3 sm:gap-4">
                    {#if row.state !== "untouched"}
                      <span class="flex items-center gap-1" aria-hidden="true">
                        {#if row.maxLevel !== null && row.maxLevel <= 10}
                          {#each Array(row.maxLevel) as _, i (i)}
                            <span class={`h-1.5 w-1.5 rounded-full ${i < (row.level ?? 0) ? "bg-accent" : "bg-surface-2"}`}></span>
                          {/each}
                        {/if}
                      </span>
                      <span class="tnum text-right text-[13px] font-semibold text-fg">
                        {row.level}{row.maxLevel !== null ? ` / ${row.maxLevel}` : ""}
                      </span>
                      <span class="tnum hidden w-24 text-right text-[11px] text-fg-faint sm:inline">
                        {row.state === "maxed" ? "complete" : row.remaining !== null ? `${row.remaining} left` : `level ${row.level}`}
                      </span>
                    {:else}
                      <span class="text-[11px] text-fg-faint">not invested</span>
                    {/if}
                    <Icon name={expandedId === row.id ? "chevron-down" : "chevron-right"} size={13} class="text-fg-faint" />
                  </span>
                </button>
                {#if expandedId === row.id}
                  <div class="border-t border-border/40 bg-bg-raise/40 px-4 py-3 sm:px-5">
                    {#if row.description}
                      <p class="max-w-2xl text-[13px] leading-relaxed text-fg-muted">{row.description}</p>
                    {/if}
                    <dl class="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:max-w-md sm:grid-cols-3">
                      <div><dt class="text-fg-faint">Rank</dt><dd class="tnum text-fg">{row.level ?? 0}</dd></div>
                      <div><dt class="text-fg-faint">Cap</dt><dd class="tnum text-fg">{row.maxLevel !== null ? row.maxLevel : "not published"}</dd></div>
                      <div><dt class="text-fg-faint">Remaining</dt><dd class="tnum text-fg">{row.remaining !== null ? row.remaining : "—"}</dd></div>
                    </dl>
                    <p class="mt-2.5 text-[11px] leading-relaxed text-fg-faint">
                      {stateLabel(row)} · {row.maxLevel !== null ? "cap from TornScope's maintained catalog" : "cap not maintained — Torn doesn't publish merit caps"}
                    </p>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
        <p class="mt-3 text-[11px] text-fg-faint">
          {filtered.length} of {data.merits.length} merits shown · ranks are exact from Torn; caps and categories are TornScope catalog metadata
        </p>
      {/if}
    </section>
  {/if}
</div>
