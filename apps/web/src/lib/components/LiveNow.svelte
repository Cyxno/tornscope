<script lang="ts">
  import type { TodayResponse } from "@tornscope/shared";
  import { formatCountdownCompact, remainingSeconds } from "@tornscope/shared";
  import { cooldownDisplay, barFullDisplay } from "$lib/live";
  import { onMount } from "svelte";

  /**
   * "Right now" as an inline sentence, not boxes. Consumes the SAME
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
    /** Proportional fill 0-100 for bar chips (Energy/Nerve) — the at-a-glance
     *  visual the strip regressed to text-only without (V0.2 pass). */
    pct?: number;
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
      pct: Math.min(100, Math.max(2, bar.percent)),
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
      // Warning ONLY when action is needed (matured → collect). A healthy
      // investment counting down is a neutral timer — warning-yellow on a
      // normal asset read as a problem (color-semantics audit).
      if (left <= 0) out.push({ key: "bank", label: "Bank", value: "Matured — collect", tone: "warning", live: false, href: "/money" });
      else if (left < 7 * 86_400) out.push({ key: "bank", label: "Bank", value: `matures in ${formatCountdownCompact(left)}`, tone: "neutral", live: true, href: "/money" });
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

  const toneTick: Record<string, string> = {
    neutral: "bg-fg-faint",
    negative: "bg-negative",
    accent: "bg-accent",
    warning: "bg-warning",
    positive: "bg-positive",
  };
</script>

{#if today}
  <!-- The live state as one inline sentence: colored ticks, no boxes.
       Values that act link out to Torn; the strip reads left to right. -->
  <section aria-label="Right now">
    <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
      {#if energyChip}
        <span class="inline-flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full {toneTick[energyChip.tone]}" aria-hidden="true"></span>
          <a href="https://www.torn.com/gym.php" target="_blank" rel="noopener noreferrer" class="font-medium text-fg transition-colors hover:text-accent" title="Open the gym in Torn">Energy</a>
          <span class="h-1 w-14 overflow-hidden rounded-full bg-surface-2 sm:w-20" aria-hidden="true">
            <span class="block h-full rounded-full {energyChip.tone === 'positive' ? 'bg-positive' : 'bg-gradient-to-r from-accent-strong to-accent'}" style={`width:${energyChip.pct ?? 0}%`}></span>
          </span>
          <span class="tnum text-fg">{energyChip.value}</span>
        </span>
      {/if}
      {#if nerveChip}
        <span class="inline-flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full {toneTick[nerveChip.tone]}" aria-hidden="true"></span>
          <a href="https://www.torn.com/crimes.php" target="_blank" rel="noopener noreferrer" class="font-medium text-fg transition-colors hover:text-accent" title="Open crimes in Torn">Nerve</a>
          <span class="h-1 w-14 overflow-hidden rounded-full bg-surface-2 sm:w-20" aria-hidden="true">
            <span class="block h-full rounded-full {nerveChip.tone === 'positive' ? 'bg-positive' : 'bg-gradient-to-r from-accent-strong to-accent'}" style={`width:${nerveChip.pct ?? 0}%`}></span>
          </span>
          <span class="tnum text-fg">{nerveChip.value}</span>
        </span>
      {/if}
      {#each cooldownChips as chip (chip.key)}
        <span class="inline-flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full {chip.tone === 'positive' ? 'bg-positive' : 'bg-fg-faint'}" aria-hidden="true"></span>
          <a href={chip.href} target="_blank" rel="noopener noreferrer" class="font-medium text-fg transition-colors hover:text-accent" title="Open items in Torn">{chip.label}</a>
          <span class="tnum {chip.tone === 'positive' ? 'text-positive' : 'text-fg'}">{chip.value}</span>
        </span>
      {/each}
      {#if ocChip}
        <span class="inline-flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true"></span>
          <a href={ocChip.href} class="font-medium text-accent transition-opacity hover:opacity-80">{ocChip.label}</a>
          <span class="tnum text-fg-muted">{ocChip.value}</span>
        </span>
      {/if}
      {#each attentionChips as chip (chip.key)}
        <span class="inline-flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full {toneTick[chip.tone]}" aria-hidden="true"></span>
          <a href={chip.href ?? "/today"} class="font-medium {chip.tone === 'negative' ? 'text-negative' : chip.tone === 'accent' ? 'text-accent' : chip.tone === 'warning' ? 'text-warning' : 'text-fg'} transition-opacity hover:opacity-80">{chip.label}</a>
          <span class="tnum text-fg-muted">{chip.value}</span>
        </span>
      {/each}
      <button class="ml-auto text-xs font-medium text-accent transition-opacity hover:opacity-80" onclick={onOpenToday}>
        Today →
      </button>
    </div>
  </section>
{/if}
