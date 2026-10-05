<script lang="ts">
  import type { HuntingSummaryResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoneyCompact } from "@tornscope/shared";
  import { createLoadGuard } from "$lib/loadGuard";
  import { activities as activitiesApi, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import * as td from "$lib/time-display.svelte.js";

  let data = $state<HuntingSummaryResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const res = await activitiesApi.hunting({ preset: dateRange.preset, from: dateRange.from, to: dateRange.to });
      if (!guard.isCurrent(seq)) return;
      data = res;
    } catch (err) {
      if (!guard.isCurrent(seq)) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      if (guard.isCurrent(seq)) loading = false;
    }
  }

  $effect(() => {
    void dateRange.preset;
    void dateRange.from;
    void reloadToken;
    void load();
  });

  function sessionLabel(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
  }
</script>

<svelte:head><title>Hunting · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Activity · Hunting"
    title="Hunting"
    description="Your logged hunting sessions — exact bait costs and prey-sale income from Torn's own logs, with the hunting-skill trajectory they record."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load hunting analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if data}
    <dl class="grid grid-cols-2 gap-y-5 md:grid-cols-5 md:divide-x md:divide-border">
      <div class="md:pr-5">
        <dt class="text-[11px] font-medium text-fg-faint">Sessions</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.hunts}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Cash earned</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.cashEarned !== null ? formatMoneyCompact(data.cashEarned) : "—"}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Bait spent</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.cashSpent !== null ? formatMoneyCompact(data.cashSpent) : "—"}</dd>
      </div>
      <div class="md:px-5">
        <dt class="text-[11px] font-medium text-fg-faint">Net cash</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold {data.netCash.value === null ? 'text-fg-faint' : data.netCash.value >= 0 ? 'text-positive' : 'text-negative'}">{data.netCash.value !== null ? formatSignedMoneyCompact(data.netCash.value) : "—"}</dd>
        <dd class="mt-0.5"><span class="text-[11px] text-fg-faint">exact</span></dd>
      </div>
      <div class="md:pl-5">
        <dt class="text-[11px] font-medium text-fg-faint">Net per session</dt>
        <dd class="tnum mt-1 text-[22px] font-semibold text-fg">{data.valuePerHunt !== null ? formatSignedMoneyCompact(data.valuePerHunt) : "—"}</dd>
      </div>
    </dl>

    <section class="section-rule" aria-label="Hunting skill">
      <h2 class="section-label">Hunting skill</h2>
      <div class="mt-3 flex flex-wrap gap-x-10 gap-y-4">
        <div>
          <p class="text-[11px] font-medium text-fg-faint">Latest recorded skill</p>
          <p class="tnum mt-1 text-[18px] font-semibold text-fg">{data.skill.current !== null ? data.skill.current.toFixed(4) : "—"}</p>
        </div>
        <div>
          <p class="text-[11px] font-medium text-fg-faint">Gain since first session</p>
          <p class="tnum mt-1 text-[18px] font-semibold text-fg">{#if data.skill.firstSeen !== null && data.skill.current !== null}{(data.skill.current - data.skill.firstSeen).toFixed(4)}{:else}—{/if}</p>
        </div>
        <div>
          <p class="text-[11px] font-medium text-fg-faint">Sum of logged gains</p>
          <p class="tnum mt-1 text-[18px] font-semibold text-fg">{data.skill.totalGain !== null ? `+${data.skill.totalGain.toFixed(4)}` : "—"}</p>
        </div>
        <div>
          <p class="text-[11px] font-medium text-fg-faint">Skill level-ups</p>
          <p class="tnum mt-1 text-[18px] font-semibold text-fg">{data.skill.levelUps}</p>
        </div>
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
        Skill values are exact strings from Torn's hunting logs. Hunting cash is semantic-only: Torn emits no money logs for prey sales, so these amounts appear here and nowhere else in TornScope — never double counted.
      </p>
    </section>

    {#if data.hunts === 0 && data.levelUps === 0}
      <StateMessage
        state="empty"
        title="No logged hunting activity in this range"
        hint="Hunting sessions appear as Torn logs sync."
      />
    {:else}
      <section class="section-rule" aria-label="Session types">
        <h2 class="section-label">By session type</h2>
        <div class="mt-3 overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Session type</th>
                <th class="text-right">Sessions</th>
                <th class="text-right">Cash earned</th>
                <th class="text-right">Bait spent</th>
                <th class="text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {#each data.sessionTypes as s (s.type)}
                <tr>
                  <td class="font-medium text-fg">{sessionLabel(s.type)}</td>
                  <td class="tnum text-right text-fg-muted">{s.hunts}</td>
                  <td class="tnum text-right text-fg-muted">{s.cashEarned !== null ? formatMoneyCompact(s.cashEarned) : "—"}</td>
                  <td class="tnum text-right text-fg-muted">{s.cashSpent !== null ? formatMoneyCompact(s.cashSpent) : "—"}</td>
                  <td class="tnum text-right font-semibold {s.net === null ? 'text-fg-faint' : s.net >= 0 ? 'text-positive' : 'text-negative'}">{s.net !== null ? formatSignedMoneyCompact(s.net) : "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if data.bestHunt}
          <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">
            Best session: {formatSignedMoneyCompact(data.bestHunt.net)} on {td.displayDate(data.bestHunt.occurredAt)}.
          </p>
        {/if}
      </section>

      {#if data.recent.length > 0}
        <section class="section-rule" aria-label="Recent sessions">
          <h2 class="section-label">Recent sessions</h2>
          <div class="mt-3 overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th class="hidden md:table-cell">Type</th>
                  <th class="text-right">Earned</th>
                  <th class="hidden md:table-cell text-right">Skill</th>
                  <th class="text-right">Net</th>
                </tr>
              </thead>
              <tbody>
                {#each data.recent as r (r.occurredAt)}
                  <tr>
                    <td class="tnum text-fg-muted">{td.displayDate(r.occurredAt)}</td>
                    <td class="hidden md:table-cell text-fg-muted">{r.subtype ? sessionLabel(r.subtype) : "—"}</td>
                    <td class="tnum text-right text-fg-muted">{r.cashEarned !== null ? formatMoneyCompact(r.cashEarned) : "—"}</td>
                    <td class="hidden md:table-cell tnum text-right text-fg-faint">
                      {#if r.skillLevel !== null}{r.skillLevel.toFixed(3)}{#if r.skillGain !== null}<span class="text-positive"> +{r.skillGain.toFixed(4)}</span>{/if}{:else}—{/if}
                    </td>
                    <td class="tnum text-right font-semibold {r.net === null ? 'text-fg-faint' : r.net >= 0 ? 'text-positive' : 'text-negative'}">{r.net !== null ? formatSignedMoneyCompact(r.net) : "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
    {/if}
  {/if}
</div>
