<script lang="ts">
  import type { TodayResponse } from "@tornscope/shared";
  import { formatCountdownCompact, remainingSeconds } from "@tornscope/shared";
  import { cooldownDisplay, barFullDisplay } from "$lib/live";
  import { onMount } from "svelte";

  /**
   * Compact "Right now" live strip for Overview. Consumes the SAME
   * /api/today payload as the Today page and derives countdowns with the
   * SAME shared helpers (cooldownDisplay / barFullDisplay) — identical
   * payload + server clock = identical state on both pages. The "Ready ·
   * just now" bug came from Overview formatting expired cooldowns with a
   * relative-time helper; these shared helpers encode the rule once.
   *
   * Energy/Nerve first (high-frequency actionable), then all three
   * cooldowns, then conditional attention states. Countdowns tick locally
   * every second while the tab is visible; no extra API calls.
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

  interface Chip {
    key: string;
    label: string;
    value: string;
    tone: "neutral" | "negative" | "accent" | "warning" | "positive";
    live: boolean;
    href?: string;
  }

  const cooldownChips = $derived.by((): Chip[] => {
    const t = today;
    if (!t) return [];
    const defs = [
      { cd: t.cooldowns.drug, icon: "drug", label: "Drug", href: "https://www.torn.com/item.php" },
      { cd: t.cooldowns.booster, icon: "booster", label: "Booster", href: "https://www.torn.com/item.php" },
      { cd: t.cooldowns.medical, icon: "medical", label: "Medical", href: "https://www.torn.com/item.php" },
    ] as const;
    return defs.map(({ cd, icon, label, href }) => {
      const display = cooldownDisplay(cd, serverNowMs);
      if (display === null) {
        return { key: `cd-${icon}`, label: `${label} cooldown`, value: "—", tone: "neutral" as const, live: false, href };
      }
      return {
        key: `cd-${icon}`,
        label: `${label} cooldown`,
        value: display.text,
        tone: display.active ? ("neutral" as const) : ("positive" as const),
        live: display.active,
        href,
      };
    });
  });

  function barChip(kind: "energy" | "nerve"): Chip | null {
    const bar = kind === "energy" ? today?.bars.energy : today?.bars.nerve;
    const d = barFullDisplay(bar, serverNowMs);
    if (!bar || !d) return null;
    return {
      key: kind,
      label: kind === "energy" ? "Energy" : "Nerve",
      // Use the shared text as-is: covers "Full in …" AND the paused/
      // indeterminate "—" without inventing a timer here.
      value: d.full ? `${bar.current} / ${bar.max}` : `${bar.current} / ${bar.max} · ${d.text}`,
      tone: d.full ? ("positive" as const) : ("accent" as const),
      live: !d.full,
    };
  }

  const energyChip = $derived(barChip("energy"));
  const nerveChip = $derived(barChip("nerve"));

  const attentionChips = $derived.by((): Chip[] => {
    const t = today;
    const out: Chip[] = [];
    if (!t) return out;
    const nowSec = Math.floor(serverNowMs / 1000);

    // Same normalized notices Today uses — Federal (and any other jail
    // variant) is classified server-side, so Overview inherits that.
    for (const [key, notice] of [["hospital", t.hospital], ["jail", t.jail]] as const) {
      if (!notice) continue;
      const left = notice.releasedAt !== null ? remainingSeconds(serverNowMs, notice.releasedAt) : null;
      out.push({
        key,
        label: notice.kind === "hospital" ? "Hospital" : "Jail",
        value: left !== null && left > 0 ? `out in ${formatCountdownCompact(left)}` : "Held indefinitely",
        tone: notice.kind === "hospital" ? "negative" : "warning",
        live: left !== null && left > 0,
        href: "/today",
      });
    }

    if (t.travel.state === "traveling" && t.travel.landsAt !== null && t.travel.landsAt > nowSec) {
      const dest = t.travel.direction === "returning" ? "home" : t.travel.country ?? "abroad";
      out.push({ key: "travel", label: `Flying to ${dest}`, value: `lands in ${formatCountdownCompact(t.travel.landsAt - nowSec)}`, tone: "accent", live: true, href: "/travel" });
    } else if (t.travel.state === "abroad" && t.travel.country) {
      out.push({ key: "abroad", label: "Abroad", value: t.travel.country, tone: "accent", live: false, href: "/travel" });
    }

    if (t.education.state === "active" && t.education.completesAt !== null && t.education.completesAt > nowSec) {
      out.push({ key: "education", label: "Education", value: `done in ${formatCountdownCompact(t.education.completesAt - nowSec)}`, tone: "neutral", live: true, href: "/today" });
    }

    if (t.bank.state === "active" && t.bank.maturesAt !== null) {
      const left = t.bank.maturesAt - nowSec;
      if (left <= 0) out.push({ key: "bank", label: "Bank", value: "Matured — collect", tone: "warning", live: false, href: "/economy" });
      else if (left < 7 * 86_400) out.push({ key: "bank", label: "Bank", value: `matures in ${formatCountdownCompact(left)}`, tone: "warning", live: true, href: "/economy" });
    }
    return out;
  });

  const ocChip = $derived.by((): Chip | null => {
    if (!ocs) return null;
    const mine = ocs.filter((o) => o.myParticipation && (o.status === "Recruiting" || o.status === "Planning"));
    const oc = mine[0];
    if (!oc) return null;
    let value = oc.status;
    if (oc.readyAt !== null) {
      const left = oc.readyAt - Math.floor(serverNowMs / 1000);
      value = left > 0 ? `ready in ${formatCountdownCompact(left)}` : "Ready";
    }
    return { key: "oc", label: `OC · ${oc.name}${oc.tier !== null ? ` · T${oc.tier}` : ""}`, value, tone: "accent", live: true, href: "/faction" };
  });
</script>

{#if today}
  <section aria-label="Right now" class="space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="section-label">Right now</h2>
      <button class="text-link text-xs font-medium" onclick={onOpenToday}>
        Today →
      </button>
    </div>

    <!-- Bars (energy/nerve) + cooldowns: the daily-use glanceables -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
      {#if energyChip}
        <a href="https://www.torn.com/gym.php" target="_blank" rel="noopener noreferrer" class="rounded-tile border border-border bg-surface px-4 py-3 transition-colors hover:border-accent/50" title="Open in Torn">
          <p class="text-[10px] font-medium uppercase tracking-[0.13em] text-fg-faint">{energyChip.label}</p>
          <p class="tnum mt-1 text-sm font-semibold text-fg">{energyChip.value}</p>
          <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div class="h-full rounded-full bg-accent" style="width: {today.bars.energy?.percent ?? 0}%"></div>
          </div>
        </a>
      {/if}
      {#if nerveChip}
        <a href="https://www.torn.com/crimes.php" target="_blank" rel="noopener noreferrer" class="rounded-tile border border-border bg-surface px-4 py-3 transition-colors hover:border-warning/60" title="Open in Torn">
          <p class="text-[10px] font-medium uppercase tracking-[0.13em] text-fg-faint">{nerveChip.label}</p>
          <p class="tnum mt-1 text-sm font-semibold text-fg">{nerveChip.value}</p>
          <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div class="h-full rounded-full bg-warning" style="width: {today.bars.nerve?.percent ?? 0}%"></div>
          </div>
        </a>
      {/if}
      {#each cooldownChips as chip (chip.key)}
        <a href={chip.href} target="_blank" rel="noopener noreferrer" class="cursor-pointer rounded-tile border bg-surface px-4 py-3 transition-colors {chip.tone === 'positive' ? 'border-positive/30 hover:border-positive/60' : 'border-border hover:border-accent/50'}" title="Open in Torn">
          <p class="text-[10px] font-medium uppercase tracking-[0.13em] text-fg-faint">{chip.label}</p>
          <p class="tnum mt-1 text-sm font-semibold {chip.tone === 'positive' ? 'text-positive' : 'text-fg'}">
            {chip.value}{#if chip.live}<span class="ml-1 text-[10px] font-normal text-fg-faint">left</span>{/if}
          </p>
        </a>
      {/each}
    </div>

    <!-- Conditional attention states: only when relevant -->
    {#if attentionChips.length > 0 || ocChip}
      <div class="flex flex-wrap gap-2">
        {#if ocChip}
          <a href={ocChip.href} class="chip chip-accent !h-auto !py-1.5 !text-xs">
            <span class="font-semibold">{ocChip.label}</span>
            <span class="tnum text-fg-muted">{ocChip.value}</span>
          </a>
        {/if}
        {#each attentionChips as chip (chip.key)}
          <a href={chip.href ?? "/today"} class="chip !h-auto !py-1.5 !text-xs {chip.tone === 'negative' ? 'chip-negative' : chip.tone === 'accent' ? 'chip-accent' : chip.tone === 'warning' ? 'chip-warning' : ''}">
            <span class="font-semibold">{chip.label}</span>
            <span class="tnum {chip.tone === 'neutral' ? 'text-fg-muted' : ''}">{chip.value}</span>
          </a>
        {/each}
      </div>
    {/if}
  </section>
{/if}
