<script lang="ts">
  import type { TodayResponse } from "@tornscope/shared";
  import { formatDateTime } from "@tornscope/shared";
  import { formatRelative } from "$lib/reltime";
  import { onMount, onDestroy } from "svelte";

  /**
   * Compact "Right now" strip for the Overview: live state chips reusing the
   * SAME Today endpoint as the Today page (one source, one calculation).
   * Conditional items only render when relevant — no permanent dead space.
   */

  let { today, onOpenToday }: { today: TodayResponse | null; onOpenToday: () => void } = $props();

  let nowSec = $state(Math.floor(Date.now() / 1000));
  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    timer = setInterval(() => (nowSec = Math.floor(Date.now() / 1000)), 30_000);
  });
  onDestroy(() => clearInterval(timer));

  const status = $derived(today?.player.status ?? null);
  const chips = $derived.by(() => {
    const out: Array<{ key: string; label: string; value: string; tone: "neutral" | "negative" | "accent" | "warning"; liveUntil?: number }> = [];
    const t = today;
    if (!t) return out;

    if (status?.state === "Hospital" && status.until !== null) {
      out.push({ key: "hospital", label: "In hospital", value: status.until > nowSec ? `out ${formatRelative(status.until)}` : "discharge due", tone: "negative", liveUntil: status.until });
    } else if (status?.state === "Jail" && status.until !== null) {
      out.push({ key: "jail", label: "In jail", value: status.until > nowSec ? `out ${formatRelative(status.until)}` : "release due", tone: "negative", liveUntil: status.until });
    }

    if (t.travel.state === "traveling" && t.travel.landsAt !== null) {
      out.push({ key: "travel-flying", label: `Traveling to ${t.travel.country ?? "abroad"}`, value: `lands ${formatRelative(t.travel.landsAt)}`, tone: "accent", liveUntil: t.travel.landsAt });
    } else if (t.travel.state === "abroad" && t.travel.country) {
      out.push({ key: "travel-abroad", label: "Abroad", value: t.travel.country, tone: "accent" });
    }

    for (const cd of [t.cooldowns.drug, t.cooldowns.medical, t.cooldowns.booster]) {
      if (cd?.state === "active" && cd.endsAt !== null) {
        out.push({ key: `cooldown-${cd.kind}`, label: `${cd.label} cooldown`, value: `ready ${formatRelative(cd.endsAt)}`, tone: "neutral", liveUntil: cd.endsAt });
      }
    }

    if (t.education.state === "active" && t.education.completesAt !== null && t.education.completesAt > nowSec) {
      out.push({ key: "education", label: "Education", value: `done ${formatRelative(t.education.completesAt)}`, tone: "neutral", liveUntil: t.education.completesAt });
    }

    if (t.bank.state === "active" && t.bank.maturesAt !== null) {
      const near = t.bank.maturesAt - nowSec < 3 * 86_400;
      if (near) out.push({ key: "bank", label: "Bank investment", value: `matures ${formatRelative(t.bank.maturesAt)}`, tone: near ? "warning" : "neutral", liveUntil: t.bank.maturesAt });
    }

    return out;
  });

  const anythingLive = $derived(chips.length > 0 || (status !== null && status.state !== "Okay" && status.state !== "hospital") || status?.state === "Okay");
</script>

{#if today}
  <section aria-label="Right now" class="space-y-3">
    <div class="flex items-center justify-between">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">Right now</h2>
      <button class="text-xs font-medium text-accent transition-opacity hover:opacity-80" onclick={onOpenToday}>
        Today →
      </button>
    </div>
    <div class="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
      <!-- Current status always present (Okay is a real state) -->
      <div class="rounded-xl border border-border bg-surface px-4 py-3">
        <p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Status</p>
        <p class="mt-1 text-sm font-medium {status?.state === 'Okay' ? 'text-positive' : status?.state === 'Hospital' || status?.state === 'Jail' ? 'text-negative' : 'text-fg'}">
          {status?.state ?? "—"}
        </p>
      </div>
      {#each chips as chip (chip.key)}
        <div class="rounded-xl border border-border bg-surface px-4 py-3">
          <p class="truncate text-[10px] uppercase tracking-[0.14em] text-fg-faint" title={chip.label}>{chip.label}</p>
          <p class="mt-1 truncate text-sm font-medium {chip.tone === 'negative' ? 'text-negative' : chip.tone === 'accent' ? 'text-accent' : chip.tone === 'warning' ? 'text-warning' : 'text-fg'}"
             title={chip.liveUntil !== undefined ? `${chip.label} · ${formatDateTime(chip.liveUntil)}` : chip.value}>
            {chip.value}
          </p>
        </div>
      {/each}
    </div>
    {#if chips.length === 0}
      <p class="text-xs text-fg-faint">No active timers — all clear. Live detail lives in <a href="/today" class="text-accent">Today</a>.</p>
    {/if}
  </section>
{/if}
