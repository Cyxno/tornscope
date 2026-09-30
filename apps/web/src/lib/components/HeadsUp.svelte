<script lang="ts">
  import type { TodayResponse } from "@tornscope/shared";
  import { dashboardNow, setDashboardClockOffset } from "$lib/dashboard-clock.svelte";
  import {
    deriveUpcomingActions,
    deriveHeadsUpCues,
    deriveTravelOcConflict,
    HEADSUP_THRESHOLD_DEFAULTS,
    type HeadsUpCue,
    type Ocs,
  } from "$lib/headsup";
  import { playHeadsUpPing } from "$lib/headsup-sound";
  import { prefs } from "$lib/state.svelte";
  import { formatCountdownCompact } from "@tornscope/shared";
  import { onMount } from "svelte";

  /**
   * Heads-up (2.0.5) — the cockpit's anticipatory layer: "this is about to
   * happen". Deterministic derivation ($lib/headsup, unit-tested) + one-shot
   * dedupe on persisted event keys, so a cue fires EXACTLY ONCE per event
   * regardless of rerenders, reloads or worker restarts.
   *
   * Renders:
   * - threshold cues (travel T-2m, drug T-2m, OC T-5m, bank T-10m — user
   *   configurable in Settings → Notifications → Heads-up thresholds),
   * - at-event cues (landing/ready/matured),
   * - the travel/OC timing-conflict warning (a STATE — visible while the
   *   conflict holds, not a one-shot).
   * Stale payloads suppress every actionable cue. Sound is opt-in,
   * device-local and fires only on a NEW unfired cue.
   */

  let { today, ocs = null, travelDurations = null, thresholds = null }: {
    today: TodayResponse | null;
    ocs?: Ocs | null;
    travelDurations?: Record<string, number> | null;
    /** /api/me headsUp shape (profile-level typeConfig, defaults filled in). */
    thresholds?: { travelPreMin: number; drugPreMin: number; boosterPreMin: number; medicalPreMin: number; ocPreMin: number; bankPreMin: number } | null;
  } = $props();

  const FIRED_KEY = "tornscope.headsup.fired.v1";

  function loadFired(): Set<string> {
    if (typeof localStorage === "undefined") return new Set();
    try {
      const raw = JSON.parse(localStorage.getItem(FIRED_KEY) ?? "[]") as unknown;
      if (!Array.isArray(raw)) return new Set();
      // Prune: keys carry their dueAt; anything older than 1h can never re-fire.
      return new Set(raw.filter((k): k is string => typeof k === "string"));
    } catch {
      return new Set();
    }
  }

  function persistFired(fired: Set<string>): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(FIRED_KEY, JSON.stringify([...fired].slice(-64)));
    } catch {
      // Storage unavailable — session-only dedupe degrades gracefully.
    }
  }

  let fired = loadFired();
  let soundPlayedFor = $state<string | null>(null);

  onMount(() => setDashboardClockOffset(today ? today.fetchedAt - Date.now() : 0));

  const nowMs = $derived(dashboardNow());
  const nowSec = $derived(Math.floor(nowMs / 1000));

  const upcoming = $derived(deriveUpcomingActions(today, ocs, nowSec));
  const resolvedThresholds = $derived({
    travel_landing: thresholds?.travelPreMin ?? HEADSUP_THRESHOLD_DEFAULTS.travel_landing,
    drug_ready: thresholds?.drugPreMin ?? HEADSUP_THRESHOLD_DEFAULTS.drug_ready,
    booster_ready: thresholds?.boosterPreMin ?? HEADSUP_THRESHOLD_DEFAULTS.booster_ready,
    medical_ready: thresholds?.medicalPreMin ?? HEADSUP_THRESHOLD_DEFAULTS.medical_ready,
    oc_ready: thresholds?.ocPreMin ?? HEADSUP_THRESHOLD_DEFAULTS.oc_ready,
    bank_matured: thresholds?.bankPreMin ?? HEADSUP_THRESHOLD_DEFAULTS.bank_matured,
    education_complete: HEADSUP_THRESHOLD_DEFAULTS.education_complete,
  });
  const cues = $derived(deriveHeadsUpCues(upcoming, resolvedThresholds, nowSec));

  // Conflict: needs the CURRENT flight + my earliest OC ready time + duration.
  const conflict = $derived.by(() => {
    if (!today) return null;
    const earliestOc = (ocs ?? [])
      .filter((o) => o.myParticipation && o.readyAt !== null)
      .sort((a, b) => (a.readyAt ?? 0) - (b.readyAt ?? 0))[0];
    const destination = today.travel.direction === "returning" ? today.travel.country : today.travel.country;
    return deriveTravelOcConflict({
      travel: today.travel,
      nowSec,
      ocReadyAt: earliestOc?.readyAt ?? null,
      ocLabel: earliestOc ? `OC · ${earliestOc.name}` : null,
      destinationDurationSeconds: destination !== null && travelDurations ? travelDurations[destination] ?? null : null,
      stale: upcoming.find((u) => u.type === "travel_landing")?.stale ?? false,
    });
  });

  // One-shot fire: NEW unfired cues are announced (sound once, if enabled)
  // and persisted. Rerenders and re-derivation never replay a fired cue.
  $effect(() => {
    const fresh = cues.filter((c) => !fired.has(c.eventKey));
    if (fresh.length === 0) return;
    for (const c of fresh) fired.add(c.eventKey);
    persistFired(fired);
    if (prefs.headsupSound && soundPlayedFor !== fresh[0]!.eventKey) {
      if (playHeadsUpPing()) soundPlayedFor = fresh[0]!.eventKey;
    }
  });

  const visibleCues = $derived(prefs.headsupCue ? cues : []);
  const showConflict = $derived(prefs.headsupCue && conflict !== null);

  function fmt(remaining: number): string {
    return remaining > 0 ? formatCountdownCompact(remaining) : "now";
  }
</script>

{#if visibleCues.length > 0 || showConflict}
  <section aria-label="Heads up">
    {#if showConflict && conflict}
      <div class="mb-2 rounded-tile border border-warning/50 bg-warning/10 px-4 py-3" role="alert">
        <p class="text-[11px] font-semibold uppercase tracking-[0.12em] text-warning">Heads up · timing conflict</p>
        <p class="mt-1 text-[13.5px] font-medium text-fg">
          {conflict.ocLabel} in {formatCountdownCompact(conflict.ocInMinutes * 60)}
          {#if conflict.phase === "outbound"}· round trip ≈ {formatCountdownCompact(conflict.estimatedReturnInMinutes * 60)}{/if}
        </p>
        <p class="mt-0.5 text-xs text-fg-muted">You may not be back in time. {conflict.travelState}.</p>
      </div>
    {/if}
    {#each visibleCues as cue (cue.eventKey)}
      <div
        class="mb-2 flex items-center justify-between gap-3 rounded-tile border px-4 py-2.5 {cue.kind === 'pre' ? 'border-warning/50 bg-warning/10' : 'border-positive/40 bg-positive/10'}"
        role="status"
      >
        <div class="min-w-0">
          <p class="text-[11px] font-semibold uppercase tracking-[0.12em] {cue.kind === 'pre' ? 'text-warning' : 'text-positive'}">
            {cue.kind === "pre" ? "Soon" : "Now"} · {cue.label}{cue.state ? ` · ${cue.state}` : ""}
          </p>
        </div>
        <span class="tnum shrink-0 text-[17px] font-semibold {cue.kind === 'pre' ? 'text-warning' : 'text-positive'}">{fmt(cue.remainingSeconds)}</span>
      </div>
    {/each}
  </section>
{/if}
