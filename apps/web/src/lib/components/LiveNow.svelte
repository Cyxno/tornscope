<script lang="ts">
  import type { TodayResponse } from "@tornscope/shared";
  import { formatCountdownCompact, remainingSeconds, TORN_URLS, TORN_LINK_ATTRS, safeTornUrl } from "@tornscope/shared";
  import { cooldownDisplay, barFullDisplay } from "$lib/live";
  import { displayTime } from "$lib/time-display.svelte.js";
  import { onMount } from "svelte";

  /**
   * "Right now" as an action board, not a sentence (1.0.3). Consumes the
   * SAME /api/today payload as the Today page and derives countdowns with
   * the SAME shared helpers (cooldownDisplay / barFullDisplay) — identical
   * payload + server clock = identical state on both pages.
   *
   * Hierarchy per live item (user remediation: TornScope hid landing times
   * in 13px muted text while Torn PDA made them prominent):
   *   LABEL → CURRENT STATE → TIME (relative + absolute) → ACTION.
   * The primary action opens the relevant TORN.COM page (players act in
   * Torn, not in analytics); the TornScope route stays available as an
   * explicit secondary "history" link. All external URLs come from the
   * audited TORN_URLS map — never inline literals — and carry
   * TORN_LINK_ATTRS (target=_blank rel=noopener noreferrer).
   *
   * Countdowns tick locally every second while the tab is visible; no
   * extra API calls. Urgency is restrained: tones mark READY states, they
   * do not decorate running timers.
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

  /** Relative countdown + absolute clock time in the display zone. */
  function bothTimes(relativeText: string, atSec: number): { relative: string; absolute: string } {
    return { relative: relativeText, absolute: displayTime(atSec) };
  }

  interface LiveItem {
    key: string;
    label: string;
    /** The current-state line ("Returning to Torn", "212 / 240", …). */
    state: string | null;
    /** Big relative countdown text; null when nothing is ticking. */
    relative: string | null;
    /** Absolute clock time the countdown points at (display zone). */
    absolute: string | null;
    /** Proportional fill 0-100 for bars. */
    pct?: number;
    tone: "neutral" | "negative" | "accent" | "warning" | "positive";
    /** Ready/full/landed — the actionable state worth emphasizing. */
    ready: boolean;
    /** Primary action: the Torn.com page (guarded https://www.torn.com). */
    tornUrl: string;
    tornAction: string;
    /** Secondary action: the TornScope analytics route. */
    scopeHref: string | null;
    scopeLabel: string | null;
  }

  function barItem(kind: "energy" | "nerve" | "happy"): LiveItem | null {
    const bar = kind === "energy" ? today?.bars.energy : kind === "nerve" ? today?.bars.nerve : today?.bars.happy;
    const d = barFullDisplay(bar, serverNowMs);
    if (!bar || !d) return null;
    const label = kind === "energy" ? "Energy" : kind === "nerve" ? "Nerve" : "Happy";
    const tornUrl = kind === "energy" ? TORN_URLS.gym : kind === "nerve" ? TORN_URLS.crimes : TORN_URLS.items;
    const tornAction = kind === "energy" ? "Open gym" : kind === "nerve" ? "Open crimes" : "Open items";
    if (d.full) {
      return { key: kind, label, state: `${bar.current} / ${bar.max}`, relative: null, absolute: null, pct: 100, tone: "positive", ready: true, tornUrl, tornAction, scopeHref: null, scopeLabel: null };
    }
    const atSec = bar.fullAt !== null ? bar.fullAt : null;
    return {
      key: kind,
      label,
      state: `${bar.current} / ${bar.max}`,
      relative: d.text.startsWith("Full in") ? d.text.slice("Full in ".length) : d.text === "—" ? null : d.text,
      absolute: d.text.startsWith("Full in") && atSec !== null ? displayTime(atSec) : null,
      pct: Math.min(100, Math.max(2, bar.percent)),
      tone: "accent",
      ready: false,
      tornUrl,
      tornAction,
      scopeHref: null,
      scopeLabel: null,
    };
  }

  const barItems = $derived([barItem("energy"), barItem("nerve"), barItem("happy")].filter((b): b is LiveItem => b !== null));

  const cooldownItems = $derived.by((): LiveItem[] => {
    const t = today;
    if (!t) return [];
    const defs = [
      { cd: t.cooldowns.drug, key: "drug", label: "Drug", tornAction: "Open items" },
      { cd: t.cooldowns.booster, key: "booster", label: "Booster", tornAction: "Open items" },
      { cd: t.cooldowns.medical, key: "medical", label: "Medical", tornAction: "Open items" },
    ] as const;
    return defs.map(({ cd, key, label, tornAction }): LiveItem | null => {
      const display = cooldownDisplay(cd, serverNowMs);
      if (display === null) return null;
      const atSec = display.active && cd?.endsAt !== null && cd?.endsAt !== undefined ? cd.endsAt : null;
      return {
        key: `cd-${key}`,
        label: `${label} cooldown`,
        state: null,
        relative: display.active ? display.text : null,
        absolute: display.active && atSec !== null ? displayTime(atSec) : null,
        tone: display.active ? "neutral" : "positive",
        ready: !display.active,
        tornUrl: TORN_URLS.items,
        tornAction,
        scopeHref: null,
        scopeLabel: null,
      };
    }).filter((i): i is LiveItem => i !== null);
  });

  const attentionItems = $derived.by((): LiveItem[] => {
    const t = today;
    const out: LiveItem[] = [];
    if (!t) return out;
    const nowSec = Math.floor(serverNowMs / 1000);

    // Hospital / jail — normalized notices, classified server-side.
    for (const [key, notice] of [["hospital", t.hospital], ["jail", t.jail]] as const) {
      if (!notice) continue;
      const left = notice.releasedAt !== null ? remainingSeconds(serverNowMs, notice.releasedAt) : null;
      out.push({
        key,
        label: notice.kind === "hospital" ? "Hospital" : "Jail",
        state: "Held indefinitely",
        relative: left !== null && left > 0 ? formatCountdownCompact(left) : null,
        absolute: left !== null && left > 0 && notice.releasedAt !== null ? displayTime(notice.releasedAt) : null,
        tone: notice.kind === "hospital" ? "negative" : "warning",
        ready: false,
        tornUrl: notice.kind === "hospital" ? TORN_URLS.hospital : TORN_URLS.jail,
        tornAction: notice.kind === "hospital" ? "Open hospital" : "Open jail",
        scopeHref: "/today",
        scopeLabel: "Today",
      });
    }

    // Travel — THE headline item when flying: destination state, big
    // relative countdown, absolute landing time, Torn action primary.
    if (t.travel.state === "traveling" && t.travel.landsAt !== null && t.travel.landsAt > nowSec) {
      const returning = t.travel.direction === "returning";
      const { relative, absolute } = bothTimes(formatCountdownCompact(t.travel.landsAt - nowSec), t.travel.landsAt);
      out.push({
        key: "travel",
        label: returning ? "Travel" : "Travel",
        state: returning ? "Returning to Torn" : `Flying to ${t.travel.country ?? "abroad"}`,
        relative,
        absolute,
        tone: "accent",
        ready: false,
        tornUrl: TORN_URLS.travel,
        tornAction: "Open travel",
        scopeHref: "/travel",
        scopeLabel: "Travel history",
      });
    } else if (t.travel.state === "abroad" && t.travel.country) {
      out.push({
        key: "abroad",
        label: "Travel",
        state: `Abroad — ${t.travel.country}`,
        relative: null,
        absolute: null,
        tone: "accent",
        ready: true,
        tornUrl: TORN_URLS.travel,
        tornAction: "Open travel",
        scopeHref: "/travel",
        scopeLabel: "Travel history",
      });
    }

    if (t.education.state === "active" && t.education.completesAt !== null && t.education.completesAt > nowSec) {
      const { relative, absolute } = bothTimes(formatCountdownCompact(t.education.completesAt - nowSec), t.education.completesAt);
      out.push({
        key: "education",
        label: "Education",
        state: "Course in progress",
        relative,
        absolute,
        tone: "neutral",
        ready: false,
        tornUrl: TORN_URLS.education,
        tornAction: "Open education",
        scopeHref: null,
        scopeLabel: null,
      });
    }

    if (t.bank.state === "active" && t.bank.maturesAt !== null) {
      const left = t.bank.maturesAt - nowSec;
      // Warning ONLY when action is needed (matured → collect); a healthy
      // counting-down investment is neutral (color-semantics audit).
      if (left <= 0) {
        out.push({
          key: "bank", label: "Bank", state: "Investment matured", relative: null, absolute: null,
          tone: "warning", ready: true, tornUrl: TORN_URLS.bank, tornAction: "Open bank", scopeHref: "/money", scopeLabel: "Money",
        });
      } else if (left < 7 * 86_400) {
        const { relative, absolute } = bothTimes(formatCountdownCompact(left), t.bank.maturesAt);
        out.push({
          key: "bank", label: "Bank", state: "Investment maturing", relative, absolute,
          tone: "neutral", ready: false, tornUrl: TORN_URLS.bank, tornAction: "Open bank", scopeHref: "/money", scopeLabel: "Money",
        });
      }
    }
    return out;
  });

  const ocItem = $derived.by((): LiveItem | null => {
    if (!ocs) return null;
    const mine = ocs.filter((o) => o.myParticipation && (o.status === "Recruiting" || o.status === "Planning"));
    const oc = mine[0];
    if (!oc) return null;
    let relative: string | null = null;
    let absolute: string | null = null;
    let ready = false;
    if (oc.readyAt !== null) {
      const left = oc.readyAt - Math.floor(serverNowMs / 1000);
      if (left > 0) {
        relative = formatCountdownCompact(left);
        absolute = displayTime(oc.readyAt);
      } else {
        ready = true;
      }
    }
    return {
      key: "oc",
      label: `OC · ${oc.name}${oc.tier !== null ? ` · T${oc.tier}` : ""}`,
      state: oc.status,
      relative,
      absolute,
      tone: ready ? "positive" : "accent",
      ready,
      tornUrl: TORN_URLS.organizedCrime,
      tornAction: "Open crimes",
      scopeHref: "/faction",
      scopeLabel: "Faction",
    };
  });

  const liveActions = $derived([...barItems, ...cooldownItems, ocItem ? [ocItem] : [], attentionItems].flat());
  const hasContent = $derived(today !== null && liveActions.length > 0);
  /** Defensive render-time guard: every rendered external href passes the
   *  domain check (the static map is https://www.torn.com by construction;
   *  this keeps the guarantee if a derived value ever joins). */
  function externalHref(url: string): string {
    return safeTornUrl(url) ?? TORN_URLS.items;
  }
</script>

{#if hasContent}
  <!-- Action board: LABEL → STATE → TIME → ACTION. Primary action opens
       Torn (external marker on every button); TornScope analytics stays
       one explicit secondary link behind. -->
  <section aria-label="Right now">
    <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <p class="section-label">Right now</p>
      <button class="text-xs font-medium text-accent transition-opacity hover:opacity-80" onclick={onOpenToday}>
        Today →
      </button>
    </div>

    <!-- Bars: energy/nerve/happy — larger fill, readable values, direct action -->
    {#if barItems.length > 0}
      <ul class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {#each barItems as item (item.key)}
          <li class="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
            <span class="min-w-0 flex-1">
              <span class="flex items-baseline justify-between gap-2">
                <span class="text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted">{item.label}</span>
                <span class="tnum text-[15px] font-semibold {item.ready ? 'text-positive' : 'text-fg'}">{item.state}</span>
              </span>
              <span class="mt-1.5 block h-2 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
                <span class="block h-full rounded-full {item.ready ? 'bg-positive' : 'bg-gradient-to-r from-accent-strong to-accent'}" style={`width:${item.pct ?? 0}%`}></span>
              </span>
              <span class="mt-1 flex min-h-[16px] items-baseline gap-x-2 text-[12px]">
                {#if item.relative}<span class="tnum font-medium {item.ready ? 'text-positive' : 'text-fg'}">{item.relative}</span>{/if}
                {#if item.absolute}<span class="tnum text-fg-muted">· {item.absolute}</span>{/if}
                {#if !item.relative && !item.absolute}<span class="text-fg-faint">not regenerating</span>{/if}
              </span>
            </span>
            <a
              href={externalHref(item.tornUrl)}
              class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1.5 text-[11px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
              title={`${item.tornAction} on Torn.com`}
              {...TORN_LINK_ATTRS}
            >
              Torn<span aria-hidden="true" class="text-[10px]">↗</span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- Timers & states: travel / OC / education / bank / cooldowns / hospital -->
    {#if cooldownItems.length > 0 || attentionItems.length > 0 || ocItem}
      <ul class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {#each [ocItem ? [ocItem] : [], attentionItems, cooldownItems].flat() as item (item.key)}
          <li class="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3">
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12px] font-medium uppercase tracking-[0.08em] text-fg-muted" title={item.label}>{item.label}</span>
              {#if item.state}<span class="mt-0.5 block truncate text-[13.5px] font-semibold {item.tone === 'negative' ? 'text-negative' : item.tone === 'warning' ? 'text-warning' : item.ready ? 'text-positive' : 'text-fg'}">{item.state}</span>{/if}
              <span class="mt-0.5 flex min-h-[18px] flex-wrap items-baseline gap-x-2 text-[13px]">
                {#if item.relative}
                  <span class="tnum text-[16px] font-semibold {item.ready ? 'text-positive' : 'text-fg'}">{item.relative}</span>
                {/if}
                {#if item.absolute}
                  <span class="tnum text-[12.5px] text-fg-muted">· {item.absolute}</span>
                {/if}
                {#if !item.relative && !item.absolute && !item.state}
                  <span class="text-fg-faint">Ready</span>
                {/if}
              </span>
              {#if item.scopeHref}
                <a href={item.scopeHref} class="mt-0.5 inline-block text-[11px] text-fg-faint underline decoration-border underline-offset-2 transition-colors hover:text-fg-muted">{item.scopeLabel}</a>
              {/if}
            </span>
            <a
              href={externalHref(item.tornUrl)}
              class="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 py-1.5 text-[11px] font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent"
              title={`${item.tornAction} on Torn.com`}
              {...TORN_LINK_ATTRS}
            >
              {item.tone === 'positive' ? 'Open ↗' : 'Torn ↗'}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
