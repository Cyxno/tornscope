<script lang="ts">
  import type { GoalsResponse } from "@tornscope/shared";
  import { confidenceChip, formatEtaRange, formatGoalValue, isStatProjection, metricLabel, progressPct, unitForMetric } from "$lib/goals-view";

  /**
   * Goals mini (Overview cockpit, 2.x) — up to three ACTIVE goals as compact
   * progress rows: metric, current / target, a slim progress bar and the
   * projection range (with its confidence chip). Assumptions live on the
   * Goals page; nothing here re-explains them. Renders NOTHING when there is
   * no goal data at all; a loaded-but-empty list gets one quiet invite line.
   */
  let { goals, maxGoals = 3 }: { goals: GoalsResponse | null; maxGoals?: number } = $props();

  const active = $derived((goals?.goals ?? []).filter((g) => g.goal.status === "active").slice(0, maxGoals));
</script>

{#if goals !== null}
  <section aria-label="Goals">
    <div class="flex items-baseline justify-between gap-3">
      <p class="section-label">Goals</p>
      {#if active.length > 0}<span class="tnum text-[11px] font-medium text-fg-faint">{active.length} active</span>{/if}
    </div>

    {#if active.length === 0}
      <p class="mt-1.5 text-[12.5px] text-fg-faint">
        No active goals — <a href="/goals" class="text-link">set one →</a>
      </p>
    {:else}
      <div class="mt-1.5 overflow-hidden rounded-tile border border-border bg-surface">
        <ul class="divide-y divide-border/60" role="list">
          {#each active as view (view.goal.id)}
            {@const unit = unitForMetric(goals.metrics, view.goal.metric)}
            {@const chip = confidenceChip(view.projection.confidence)}
            <li class="px-4 py-2.5">
              <a href="/goals" class="group block">
                <div class="flex items-baseline justify-between gap-3">
                  <span class="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-muted group-hover:text-accent">{metricLabel(goals.metrics, view.goal.metric)}</span>
                  <span class="tnum text-[13px] font-medium text-fg">
                    {formatGoalValue(view.currentValue, unit)}
                    <span class="text-fg-faint">/ {formatGoalValue(view.goal.target, unit)}</span>
                  </span>
                </div>
                <div
                  class="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-border"
                  role="progressbar"
                  aria-label="{metricLabel(goals.metrics, view.goal.metric)} goal progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((progressPct(view.progress) ?? 0))}
                >
                  <span class="block h-full rounded-full bg-gradient-to-r from-accent-strong to-accent" style={`width:${progressPct(view.progress) ?? 0}%`}></span>
                </div>
                <div class="mt-1 flex items-baseline justify-between gap-2 text-[11.5px]">
                  {#if view.projection.etaAt !== null}
                    <span class="tnum text-fg-muted">
                      {#if isStatProjection(view.projection.model) && view.projection.etaRangeDays}
                        ~{formatEtaRange(view.projection.etaRangeDays)?.replace(/~/g, "")}
                      {:else}
                        ETA {new Date(view.projection.etaAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      {/if}
                    </span>
                  {:else}
                    <span class="text-fg-faint">no projection</span>
                  {/if}
                  <span class={`chip ${chip.class} !px-1.5 !py-0 !text-[9px] !font-semibold !uppercase`} title={chip.title}>{chip.label}</span>
                </div>
              </a>
            </li>
          {/each}
        </ul>
        <p class="border-t border-border/60 px-4 py-2 text-right">
          <a href="/goals" class="text-xs font-medium text-accent transition-opacity hover:opacity-80">All goals →</a>
        </p>
      </div>
    {/if}
  </section>
{/if}
