<script lang="ts">
  import type { TodayResponse } from "@tornscope/shared";
  import { TORN_URLS, TORN_LINK_ATTRS, safeTornUrl } from "@tornscope/shared";
  import { deriveLiveBoard } from "$lib/live-now";
  import { displayTime } from "$lib/time-display.svelte.js";
  import { onMount } from "svelte";

  /**
   * "Right now" action board (1.0.3, polish pass). Derivation lives in
   * $lib/live-now (tested there); this component is the rendering shell.
   *
   * Card interaction model: the WHOLE card is the Torn.com link — a
   * stretched anchor (absolute inset-0) keeps a semantic <a>, Enter
   * activation and visible focus while letting the secondary TornScope
   * analytics link (z-10) sit above it without nested anchors. A faint ↗
   * in the corner is the only external hint; no button-looking pills.
   * Compact vertical rhythm: padding and gaps carry the density, type
   * sizes are unchanged.
   */

  let { today, ocs = null, onOpenToday }: {
    today: TodayResponse | null;
    ocs?: Array<{ name: string; tier: number | null; status: string; readyAt: number | null; myParticipation: boolean }> | null;
    onOpenToday: () => void;
  } = $props();

  let nowMs = $state(Date.now());
  let offsetMs = $state(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  const serverNowMs = $derived(nowMs + offsetMs);

  $effect(() => {
    if (today) offsetMs = today.fetchedAt - Date.now();
  });

  onMount(() => {
    timer = setInterval(() => {
      if (document.visibilityState === "visible") nowMs = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const board = $derived(deriveLiveBoard(today, ocs, serverNowMs, displayTime));
  const hasContent = $derived(board.bars.length > 0 || board.timers.length > 0);

  /** Render-time guard: every card href passes the Torn-domain check. */
  function externalHref(url: string): string {
    return safeTornUrl(url) ?? TORN_URLS.items;
  }
</script>

{#if hasContent}
  <!-- Action board: LABEL → STATE → TIME → (whole card = Torn action). -->
  <section aria-label="Right now">
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <p class="section-label">Right now</p>
      <button class="text-xs font-medium text-accent transition-opacity hover:opacity-80" onclick={onOpenToday}>
        Today →
      </button>
    </div>

    <!-- Bars: energy/nerve/happy -->
    {#if board.bars.length > 0}
      <ul class="mt-2.5 grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {#each board.bars as item (item.key)}
          <li class="group relative flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 transition-colors hover:border-accent/60 hover:bg-accent/5">
            <a
              href={externalHref(item.tornUrl)}
              class="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label={`${item.tornLabel} on Torn.com (opens in a new tab)`}
              {...TORN_LINK_ATTRS}
            ></a>
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline justify-between gap-2">
                <span class="text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{item.label}</span>
                <span class="tnum text-[15px] font-semibold {item.ready ? 'text-positive' : 'text-fg'}">{item.state}</span>
              </span>
              <span class="mt-1 block h-2 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
                <span class="block h-full rounded-full {item.ready ? 'bg-positive' : 'bg-gradient-to-r from-accent-strong to-accent'}" style={`width:${item.pct ?? 0}%`}></span>
              </span>
              <span class="mt-0.5 flex min-h-[16px] items-baseline gap-x-2 text-[12px]">
                {#if item.relative}<span class="tnum font-medium {item.ready ? 'text-positive' : 'text-fg'}">{item.relative}</span>{/if}
                {#if item.absolute}<span class="tnum text-fg-muted">· {item.absolute}</span>{/if}
                {#if !item.relative && !item.absolute}<span class="text-fg-faint">not regenerating</span>{/if}
              </span>
            </span>
            <span class="pointer-events-none absolute right-2.5 top-2 text-[11px] text-fg-faint transition-colors group-hover:text-accent" aria-hidden="true">↗</span>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- Timers & states: OC / travel / education / bank / hospital / cooldowns -->
    {#if board.timers.length > 0}
      <ul class="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {#each board.timers as item (item.key)}
          <li class="group relative flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 transition-colors hover:border-accent/60 hover:bg-accent/5">
            <a
              href={externalHref(item.tornUrl)}
              class="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label={`${item.tornLabel} on Torn.com (opens in a new tab)`}
              {...TORN_LINK_ATTRS}
            ></a>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted" title={item.label}>{item.label}</span>
              {#if item.state}
                <span class="mt-0.5 block truncate text-[13.5px] font-semibold {item.tone === 'negative' ? 'text-negative' : item.tone === 'warning' ? 'text-warning' : item.ready ? 'text-positive' : 'text-fg'}">{item.state}</span>
              {/if}
              <span class="mt-0.5 flex min-h-[18px] flex-wrap items-baseline gap-x-2 text-[13px]">
                {#if item.relative}
                  <span class="tnum text-[16px] font-semibold {item.ready ? 'text-positive' : 'text-fg'}">{item.relative}</span>
                {/if}
                {#if item.absolute}
                  <span class="tnum text-[12.5px] text-fg-muted">· {item.absolute}</span>
                {/if}
                {#if item.scopeHref}
                  <a
                    href={item.scopeHref}
                    class="relative z-10 ml-auto text-[11px] text-fg-faint underline decoration-border underline-offset-2 transition-colors hover:text-fg-muted"
                  >{item.scopeLabel}</a>
                {/if}
              </span>
            </span>
            <span class="pointer-events-none absolute right-2.5 top-2 text-[11px] text-fg-faint transition-colors group-hover:text-accent" aria-hidden="true">↗</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
