<script lang="ts">
  import type { TodayResponse } from "@tornscope/shared";
  import { TORN_URLS, TORN_LINK_ATTRS, safeTornUrl } from "@tornscope/shared";
  import { deriveLiveBoard, type LiveItem, type LiveBoard } from "$lib/live-now";
import Icon from "./Icon.svelte";
  import { displayTime } from "$lib/time-display.svelte.js";
  import { dashboardNow } from "$lib/dashboard-clock.svelte";

  /**
   * "Right now" — the LIVE cockpit block of the Overview (dashboard-first
   * redesign, 2.x). One component, one shared 1s tick, three sub-blocks:
   *
   *   1. LIVE STATUS — the dominant bar rows (Energy/Nerve/Happy/Life):
   *      big current/max numerals, a full-width bar, compact timer. STATE
   *      lives here; actions live in Needs Attention.
   *   2. COOLDOWNS — compact tiles (Drug/Booster/Medical): READY is
   *      immediately recognizable, otherwise a large countdown. Tiles only
   *      render when the payload carries that cooldown.
   *   3. ACTIVE STATES — only CURRENT states. Travel is CANONICAL and
   *      always renders exactly once (flying/returning/landed/abroad/
   *      stale/unavailable as priority rows; a compact Home row closes the
   *      block) — hidden is never a travel state.
   *
   * All derivation stays in $lib/live-now (unit-tested): over-cap energy,
   * bank-maturity semantics, cooldown readiness. Interaction model is the
   * proven stretched-anchor: the whole row/tile is the primary Torn.com
   * action (semantic <a>, keyboard activatable), with the TornScope
   * analytics link layered above it (z-10, never nested anchors).
   */

  let { today, ocs = null, onOpenToday }: {
    today: TodayResponse | null;
    ocs?: Array<{ name: string; tier: number | null; status: string; readyAt: number | null; myParticipation: boolean }> | null;
    onOpenToday: () => void;
  } = $props();

  // NOTE: server-clock sync does NOT live here. The clock offset is applied
  // where a payload arrives (the page's load flow, plain code): an effect
  // writing the shared clock — which this component renders from — re-runs
  // off its own write and deadlocks the graph at the first clock tick
  // (effect_update_depth_exceeded, bisect-confirmed 2.0.7).
  const serverNowMs = $derived(dashboardNow());

  const board: LiveBoard = $derived(deriveLiveBoard(today, ocs, serverNowMs, displayTime));
  const cooldownTiles = $derived(board.timers.filter((t) => t.key.startsWith("cd-")));
  const activeStates = $derived(board.timers.filter((t) => !t.key.startsWith("cd-")));

  /** Cooldown tiles drop the wordy " cooldown" suffix — the tile IS one. */
  function tileLabel(item: LiveItem): string {
    return item.label.replace(/ cooldown$/i, "");
  }

  /** Render-time guard: every row href passes the Torn-domain check. */
  function externalHref(url: string): string {
    return safeTornUrl(url) ?? TORN_URLS.items;
  }

  /** Existing icon set only — semantically clear states, no decoration. */
  function iconFor(item: LiveItem): "travel" | "faction" | "wallet" | "progression" | "alert" | "clock" {
    if (item.key === "travel" || item.key === "abroad") return "travel";
    if (item.key === "oc") return "faction";
    if (item.key === "bank") return "wallet";
    if (item.key === "education") return "progression";
    if (item.key === "hospital" || item.key === "jail") return "alert";
    return "clock";
  }


</script>

{#if board.bars.length > 0 || board.timers.length > 0}
  <section aria-label="Right now">
    <!-- ── 1 · LIVE STATUS — the visual heart: four dominant bar rows ── -->
    {#if board.bars.length > 0}
      <div class="overflow-hidden rounded-tile border border-border bg-surface">
        <ul class="divide-y divide-border/60" role="list">
          {#each board.bars as item (item.key)}
            {@const parts = (item.state ?? "").split(" / ")}
            {@const cur = parts[0] ?? item.state ?? ""}
            {@const max = parts[1] ?? ""}
            <li class="group relative px-4 py-3 transition-colors hover:bg-accent/5">
              <a
                href={externalHref(item.tornUrl)}
                class="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                aria-label={`${item.tornLabel} on Torn.com (opens in a new tab)`}
                {...TORN_LINK_ATTRS}
              ></a>
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-muted">{item.label}</span>
                <span class="tnum text-[20px] font-semibold leading-none {item.ready ? 'text-positive' : 'text-fg'}">
                  {cur}<span class="tnum text-[13px] font-medium text-fg-faint"> / {max}</span>
                </span>
              </div>
              <div
                class="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-border"
                role="progressbar"
                aria-label="{item.label}"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(item.pct ?? (item.ready ? 100 : 0))}
              >
                <span class="block h-full rounded-full {item.ready ? 'bg-positive' : 'bg-gradient-to-r from-accent-strong to-accent'}" style={`width:${item.pct ?? (item.ready ? 100 : 0)}%`}></span>
              </div>
              <div class="mt-1.5 flex min-h-[18px] items-baseline justify-between gap-3 text-[12.5px]">
                <span class="tnum font-medium {item.ready ? 'text-positive' : item.tone === 'accent' && item.relative ? 'text-fg' : 'text-fg-muted'}">{item.relative ?? (item.ready ? "Full" : "—")}</span>
                <span class="tnum text-[11.5px] text-fg-faint">{item.absolute ?? ""}</span>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- ── 2 · COOLDOWNS — compact tiles: READY or a big countdown ── -->
    {#if cooldownTiles.length > 0}
      <ul class="mt-3 grid grid-cols-3 gap-2" role="list" aria-label="Cooldowns">
        {#each cooldownTiles as item (item.key)}
          <li class="group relative rounded-tile border border-border bg-surface px-3 py-2.5 transition-colors {item.ready ? 'border-positive/40 bg-positive/5' : 'hover:border-accent/60'}">
            <a
              href={externalHref(item.tornUrl)}
              class="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              aria-label={`${item.tornLabel} on Torn.com (opens in a new tab)`}
              {...TORN_LINK_ATTRS}
            ></a>
            <span class="block text-[10.5px] font-semibold uppercase tracking-[0.12em] text-fg-muted">{tileLabel(item)}</span>
            <span class="mt-1 block truncate text-[17px] font-semibold leading-tight {item.ready ? 'text-positive' : 'text-fg'}">
              {item.ready ? "READY" : item.relative ?? "—"}
            </span>
            <span class="mt-0.5 block min-h-[14px] truncate text-[11px] text-fg-faint">{item.ready ? "use it now" : item.absolute ?? ""}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- ── 3 · ACTIVE STATES — only what is CURRENT (travel/education/OC/
            bank/hospital/jail). Travel is a CANONICAL state and always
            renders: priority rows (flying/returning/landed/abroad) sit at
            the top with an accent marker; the compact Home row closes the
            block — hidden is never a travel state. ── -->
    {#if activeStates.length > 0}
      <div class="mt-3 overflow-hidden rounded-tile border border-border bg-surface">
        <ul class="divide-y divide-border/60" role="list" aria-label="Active states">
          {#each activeStates as item (item.key)}
            <li class="group relative px-4 py-2.5 transition-colors hover:bg-accent/5 {item.priority ? 'border-l-2 border-l-accent bg-accent/[0.04]' : ''}">
              <a
                href={externalHref(item.tornUrl)}
                class="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                aria-label={`${item.tornLabel} on Torn.com (opens in a new tab)`}
                {...TORN_LINK_ATTRS}
              ></a>
              <div class="flex items-baseline justify-between gap-3">
                <span class="flex min-w-0 items-baseline gap-2">
                  <span class="shrink-0 text-fg-faint" aria-hidden="true"><Icon name={iconFor(item)} size={12} /></span>
                  <span class="text-[11px] font-semibold uppercase tracking-[0.12em] {item.priority ? 'text-accent' : 'text-fg-muted'}">{item.label}</span>
                  {#if item.state}<span class="min-w-0 truncate text-[13px] {item.priority ? 'font-medium' : ''} text-fg">{item.state}</span>{/if}
                </span>
                <span class="flex shrink-0 items-baseline gap-2">
                  {#if item.relative}
                    <span class="tnum text-[16px] font-semibold {item.ready ? 'text-positive' : item.priority ? 'text-accent' : item.tone === 'negative' ? 'text-negative' : item.tone === 'warning' ? 'text-warning' : 'text-fg'}">{item.relative}</span>
                  {/if}
                  {#if item.scopeHref}
                    <a
                      href={item.scopeHref}
                      class="relative z-10 text-[11px] text-fg-faint underline decoration-border underline-offset-2 transition-colors hover:text-fg-muted"
                    >{item.scopeLabel}</a>
                  {/if}
                </span>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <p class="mt-2 text-right">
      <button class="text-xs font-medium text-accent transition-opacity hover:opacity-80" onclick={onOpenToday}>
        Today's activity →
      </button>
    </p>
  </section>
{/if}
