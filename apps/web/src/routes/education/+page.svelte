<script lang="ts">
  import { createLoadGuard } from "$lib/loadGuard";
  import type { ProgressionResponse, EducationCourseDto, AccountEffect } from "@tornscope/shared";
  import Countdown from "$lib/components/Countdown.svelte";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import * as td from "$lib/time-display.svelte.js";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  let progression = $state<ProgressionResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  // Education (2.8.2 contracts, 2.8.3 own page): client-side filter + search
  // over the catalog rows delivered in the progression payload. Education is
  // account state — the range param below is required by the shared endpoint
  // but the education block itself is range-independent.
  let eduFilter = $state<"all" | "completed" | "in_progress" | "remaining">("all");
  let eduQuery = $state("");
  const education = $derived(progression?.education ?? null);
  const eduFiltered = $derived.by(() => {
    if (!education) return [];
    const q = eduQuery.trim().toLowerCase();
    return education.courses.filter((c) => {
      if (eduFilter !== "all" && c.state !== eduFilter) return false;
      if (q && !`${c.name} ${c.categoryName}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });
  function eduRewardLine(course: EducationCourseDto): string {
    const bits: string[] = [];
    if (course.reward.manualLabor) bits.push(`+${course.reward.manualLabor} manual`);
    if (course.reward.intelligence) bits.push(`+${course.reward.intelligence} int`);
    if (course.reward.endurance) bits.push(`+${course.reward.endurance} end`);
    bits.push(...course.reward.effects, ...course.reward.honors.map((h) => `Honor: ${h}`));
    return bits.join(" · ");
  }

  // Account effects (2.8.4): combined active bonuses — merits + COMPLETED
  // courses only (future course rewards are never active). Display grouping:
  // percent rows first, then flat, then special.
  const UNIT_ORDER = { percent: 0, flat: 1, special: 2 } as const;
  function rowUnit(effect: AccountEffect): "percent" | "flat" | "special" {
    return effect.merit?.unit ?? effect.education?.unit ?? "special";
  }
  const activeEffects = $derived.by(() => {
    const rows = education?.accountEffects ?? [];
    return [...rows].sort(
      (a, b) => a.group.localeCompare(b.group) || UNIT_ORDER[rowUnit(a)] - UNIT_ORDER[rowUnit(b)] || a.label.localeCompare(b.label)
    );
  });
  const unknownEffects = $derived(education?.unknownEducationEffects ?? []);
  const degrees = $derived((education?.categories ?? []).filter((c) => c.complete));

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const res = await endpoints.progression(range);
      if (!guard.isCurrent(seq)) return; // a newer load superseded this response
      progression = res;
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
</script>

<svelte:head><title>Education · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Progression"
    title="Education"
    description="Current course, catalog progress and course rewards — account state read directly from Torn's education resource, not a date-range view."
  />

  {#if loading && !progression}
    <StateMessage state="loading" />
  {:else if error && !progression}
    <StateMessage state="error" title="Could not load education progress" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if education}
    <!-- ═══ Account effects (2.8.4) — combined active bonuses ═══ -->
    <section class="space-y-4" aria-label="Account effects">
      <div class="grid gap-4 lg:grid-cols-3">
        <Panel title="Account effects" caption="Active bonuses right now — merits + completed courses, one row per effect family" class="lg:col-span-2">
          {#if activeEffects.length === 0 && unknownEffects.length === 0}
            <p class="text-[14px] text-fg-muted">No provable active bonuses yet — invest merit ranks or complete courses.</p>
          {:else}
            <ul class="space-y-2 text-[13px]">
              {#each activeEffects as effect (effect.key)}
                <li class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span class="min-w-0">
                    <span class="text-fg">{effect.label}</span>
                    {#each effect.sources as source (source)}
                      <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">{source === "merits" ? "Merits" : "Education"}</span>
                    {/each}
                  </span>
                  <span class="tnum shrink-0 text-right">
                    {#if effect.merit}
                      <span class={`font-semibold ${effect.merit.direction === "increase" ? "text-positive" : "text-accent"}`}>
                        {effect.merit.direction === "reduce" ? "−" : "+"}{effect.merit.total}{effect.merit.unit === "percent" ? "%" : ""}
                      </span>
                      <span class="text-[10px] text-fg-faint"> merit{effect.merit.unit === "special" ? " · per rank" : ""}</span>
                    {/if}
                    {#if effect.education}
                      <span class={`font-semibold ${effect.merit ? "" : effect.education.direction === "increase" ? "text-positive" : "text-accent"}`}>
                        {effect.education.direction === "reduce" ? "−" : "+"}{effect.education.total}{effect.education.unit === "percent" ? "%" : ""}
                      </span>
                      <span class="text-[10px] text-fg-faint"> courses ({effect.education.courses})</span>
                    {/if}
                  </span>
                </li>
              {/each}
              {#each unknownEffects as text (text)}
                <li class="flex items-baseline justify-between gap-3">
                  <span class="min-w-0 text-fg-muted">{text}</span>
                  <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">Education · not quantified</span>
                </li>
              {/each}
            </ul>
            <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
              Merit figures are exact (rank × verified per-rank formula); course figures quote the official catalog text — never inferred from prose. Both sources are listed separately, never summed. Future course rewards (below) are not active.
            </p>
          {/if}
        </Panel>
        <Panel title="Earned bonuses & degrees" caption="From completed courses — working stats are exact catalog values (totals below)">
          <p class="tnum text-[15px] font-semibold text-fg">
            <span class="text-positive">{degrees.length}</span> of {education.categories.length} categories fully complete
          </p>
          <p class="mt-1.5 truncate text-[12px] text-fg-muted">{degrees.length ? degrees.map((d) => d.name).join(", ") : "No degree completed yet."}</p>
          <p class="tnum mt-2 text-[11px] text-fg-faint">{education.earned.honors.length} honors earned from completed courses</p>
          <p class="mt-1.5 text-[11px] leading-relaxed text-fg-faint">
            Ability/feature unlocks are not published by Torn's API — only course completion and catalog rewards are known; anything beyond that stays unknown.
          </p>
        </Panel>
      </div>
    </section>

    <section class="space-y-4" aria-label="Education">
      <div class="grid gap-4 lg:grid-cols-3">
        <Panel title="Current course" caption="Live from Torn — exact completion time" class="lg:col-span-2">
          {#if education.currentCourse}
            <div class="flex items-baseline justify-between gap-3">
              <div class="min-w-0">
                <p class="truncate text-[15px] font-semibold text-fg">{education.currentCourse.name}</p>
                <p class="mt-0.5 text-[12px] text-fg-muted">{education.currentCourse.categoryName}</p>
              </div>
              <div class="shrink-0 text-right">
                <Countdown seconds={education.currentCourse.remainingSeconds} style="clock" class="text-[17px] font-semibold" />
                <p class="tnum mt-0.5 text-[11px] text-fg-faint">{td.displayDateTime(education.currentCourse.completesAt)}</p>
              </div>
            </div>
          {:else}
            <p class="text-[14px] text-fg-muted">No course in progress.</p>
          {/if}
          <p class="mt-3 text-[11px] text-fg-faint">
            Completed {education.completed} of {education.total} courses{education.inProgress > 0 ? ` · ${education.inProgress} in progress` : ""} · completion history is not published by Torn (current + completed state only).
          </p>
        </Panel>
        <Panel title="Category progress" caption="A category completes as a degree when every course is done">
          <ul class="space-y-2 text-[12px]">
            {#each education.categories as cat (cat.name)}
              <li>
                <div class="flex items-baseline justify-between gap-2">
                  <span class="truncate {cat.complete ? 'text-positive' : 'text-fg-muted'}">{cat.name}{cat.complete ? " ✓" : ""}</span>
                  <span class="tnum shrink-0 text-fg-faint">{cat.completed}/{cat.total}</span>
                </div>
                <div class="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                  <div class="h-full rounded-full {cat.complete ? 'bg-positive' : 'bg-accent/70'}" style={`width:${Math.round((cat.completed / cat.total) * 100)}%`}></div>
                </div>
              </li>
            {/each}
          </ul>
        </Panel>
      </div>
      <div class="grid gap-4 lg:grid-cols-2">
        <Panel title="Earned rewards" caption="From completed courses only — exact catalog values">
          <p class="tnum text-[15px] font-semibold text-fg">
            +{education.earned.manualLabor} manual · +{education.earned.intelligence} int · +{education.earned.endurance} end
          </p>
          <p class="tnum mt-1 text-[11px] text-fg-faint">{education.earned.effects.length} course effects · {education.earned.honors.length} honors earned</p>
        </Panel>
        <Panel title="Future rewards" caption="Remaining + in-progress courses — not yet earned">
          <p class="tnum text-[15px] font-semibold text-fg">
            +{education.future.manualLabor} manual · +{education.future.intelligence} int · +{education.future.endurance} end
          </p>
          <p class="tnum mt-1 text-[11px] text-fg-faint">{education.future.effects.length} course effects · {education.future.honors.length} honors available</p>
        </Panel>
      </div>
      <Panel title="Courses" caption="{education.completed} completed · {education.remaining} remaining of {education.total}">
        {#snippet actions()}
          <div class="flex flex-wrap items-center gap-2">
            <div class="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-1" role="group" aria-label="Education filter">
              {#each [["all", "All"], ["completed", "Completed"], ["in_progress", "In progress"], ["remaining", "Remaining"]] as [value, label] (value)}
                <button
                  class={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${eduFilter === value ? "bg-accent/15 text-accent" : "text-fg-muted hover:text-fg"}`}
                  onclick={() => (eduFilter = value as typeof eduFilter)}
                >{label}</button>
              {/each}
            </div>
            <input
              class="w-36 rounded-full border border-border bg-surface px-3 py-1 text-[12px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none"
              placeholder="Search…"
              bind:value={eduQuery}
              aria-label="Search education courses"
            />
          </div>
        {/snippet}
        <div class="overflow-x-auto">
          <table class="tsv-table">
            <thead>
              <tr>
                <th>Course</th>
                <th>Category</th>
                <th>State</th>
                <th class="hidden text-right md:table-cell">Days</th>
                <th>Reward / effect</th>
              </tr>
            </thead>
            <tbody>
              {#each eduFiltered as course (course.id)}
                <tr>
                  <td class="max-w-[220px] truncate text-fg" title={course.name}>{course.name}</td>
                  <td class="text-xs text-fg-muted">{course.categoryName}</td>
                  <td>
                    <span class={`chip ${course.state === "completed" ? "chip-positive" : course.state === "in_progress" ? "chip-accent" : ""}`}>
                      {course.state === "completed" ? "Completed" : course.state === "in_progress" ? "In progress" : "Remaining"}
                    </span>
                  </td>
                  <td class="tnum hidden text-right text-fg-muted md:table-cell">{course.durationDays ?? "—"}</td>
                  <td class="max-w-[320px] truncate text-xs text-fg-muted" title={eduRewardLine(course)}>{eduRewardLine(course) || "—"}</td>
                </tr>
              {:else}
                <tr><td colspan="5" class="px-4 py-4 text-center text-[13px] text-fg-faint">No courses match this filter.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  {:else}
    <StateMessage state="empty" title="Education data not available yet" hint="Education state arrives with the next progression sync." />
  {/if}
</div>
