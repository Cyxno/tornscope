<script lang="ts">
  import { dashboardNow } from "$lib/dashboard-clock.svelte";
  import type { ActionItem } from "@tornscope/shared";
  import { deriveCommandCenter } from "$lib/command-center-view";
  import Countdown from "./Countdown.svelte";
  import Icon from "./Icon.svelte";

  /**
   * Command Center (2.0) — the prioritized attention feed at the top of the
   * Overview. Derivation lives in $lib/command-center-view (tested there);
   * this component is the rendering shell, sibling to the "Right now" board.
   *
   * Interaction model: an item WITH an analytics destination is ONE whole-row
   * stretched anchor (the LiveNow card pattern — semantic <a>, visible
   * focus); items without one render as plain rows, never fake links. The
   * priority accent is a colored dot PLUS screen-reader text — never color
   * alone. A future deadline ticks as a compact countdown.
   */

  let { items, maxItems = Number.POSITIVE_INFINITY }: { items: ActionItem[]; maxItems?: number } = $props();



  /** Overview shows only the few items that matter NOW (2–4); the full
   *  prioritized logic stays in command-center-view (tested there). */
  const feed = $derived(deriveCommandCenter(items, Math.floor(dashboardNow())).slice(0, maxItems));
</script>

<section aria-label="Needs attention">
  <div class="flex items-baseline justify-between gap-3">
    <p class="section-label">Needs attention</p>
    {#if feed.length > 0}<span class="tnum text-[11px] font-medium text-fg-faint">{feed.length} item{feed.length === 1 ? "" : "s"}</span>{/if}
  </div>
  {#if feed.length === 0}
    <p class="mt-1.5 text-[12.5px] text-fg-faint">Nothing needs attention — all clear.</p>
  {:else}
    <ul role="list" class="mt-1.5 grid grid-cols-1 gap-1.5">
      {#each feed as entry (entry.key)}
        <li
          role="listitem"
          class="group relative flex items-start gap-3 rounded-xl border border-border bg-surface px-3 py-2 {entry.analyticsUrl
            ? 'transition-colors hover:border-accent/60 hover:bg-accent/5'
            : ''}"
        >
          {#if entry.analyticsUrl}
            <a
              href={entry.analyticsUrl}
              class="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label={`${entry.title} — open analytics${entry.deadline ? ` (${entry.deadline})` : ""}`}
            ></a>
          {/if}
          <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-fg-muted" aria-hidden="true">
            <Icon name={entry.icon} size={13} />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full {entry.tone.dot}" aria-hidden="true"></span>
              <span class="text-[13.5px] font-semibold text-fg">{entry.title}</span>
              <span class="sr-only"> — {entry.tone.label}</span>
              {#if entry.deadlineSeconds !== null}
                <!-- mr-5 keeps the countdown clear of the corner arrow that
                     absolutely-positioned link rows draw at right-2.5. -->
                <span class="tnum ml-auto text-[13px] font-semibold {entry.tone.text} {entry.analyticsUrl ? 'mr-5' : ''}">
                  in&nbsp;<Countdown seconds={entry.deadlineSeconds} style="compact" />
                </span>
              {/if}
            </span>
            <span class="mt-0.5 block text-xs leading-relaxed text-fg-muted">{entry.explanation}</span>
          </span>
          {#if entry.analyticsUrl}
            <span class="pointer-events-none absolute right-2.5 top-2 text-[11px] text-fg-faint transition-colors group-hover:text-accent" aria-hidden="true">↗</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
