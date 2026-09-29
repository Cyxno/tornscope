<script lang="ts">
  import { onMount } from "svelte";
  import { DEFAULT_PROJECTION_LOOKBACK, type GoalView, type GoalsResponse, type ProjectionLookbackDays } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import {
    asOfLabel,
    confidenceChip,
    formatGoalValue,
    formatVelocity,
    goalDraftError,
    insufficientReasonLabel,
    metricDescription,
    metricLabel,
    normalizeNote,
    noteError,
    progressPct,
    splitGoals,
    targetDateToUnix,
    targetError,
    unitForMetric,
    unixToTargetDate,
    isStatProjection,
    formatEtaRange,
    STAT_PROJECTION_ASSUMPTIONS,
  } from "$lib/goals-view";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import ProvenanceBadge from "$lib/components/ProvenanceBadge.svelte";
  import * as td from "$lib/time-display.svelte.js";

  /**
   * Goals — personal targets with honest trend projections.
   *
   * A projection extrapolates the OBSERVED trend over the selected lookback
   * and withholds the ETA entirely when history is short, noisy or moving the
   * wrong way (mapped copy from $lib/goals-view — codes never render).
   * "Achieved" is derived server-side; the page only archives/unarchives.
   */

  const LOOKBACKS: readonly ProjectionLookbackDays[] = [7, 30, 90];

  let data = $state<GoalsResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let lookback = $state<ProjectionLookbackDays>(DEFAULT_PROJECTION_LOOKBACK);
  let loadSeq = 0;

  // Create form.
  let metric = $state("");
  let target = $state("");
  let note = $state("");
  let targetDate = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  // Per-goal action state.
  let busyId = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let editingId = $state<string | null>(null);
  let editTarget = $state("");
  let editNote = $state("");
  let editTargetDate = $state("");

  async function load() {
    const seq = ++loadSeq;
    loading = true;
    error = null;
    try {
      const res = await endpoints.goals(lookback);
      if (seq !== loadSeq) return;
      data = res;
      if (!metric && res.metrics.length > 0) metric = res.metrics[0]!.id;
    } catch (err) {
      if (seq !== loadSeq) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      data = null;
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  function setLookback(days: ProjectionLookbackDays) {
    if (days === lookback) return;
    lookback = days;
    void load();
  }

  const groups = $derived(data ? splitGoals(data.goals) : { active: [], archived: [] });
  const selectedDescription = $derived(data ? metricDescription(data.metrics, metric) : "");
  const selectedUnit = $derived(data ? unitForMetric(data.metrics, metric) : "stat");
  const targetPreview = $derived(target.trim() && !Number.isNaN(Number(target)) && Number(target) > 0 ? formatGoalValue(Number(target), selectedUnit) : "");

  function startEdit(view: GoalView) {
    editingId = view.goal.id;
    editTarget = String(view.goal.target);
    editNote = view.goal.note ?? "";
    editTargetDate = unixToTargetDate(view.goal.targetDate);
  }

  function cancelEdit() {
    editingId = null;
  }

  async function createGoal() {
    if (!data) return;
    const problem = goalDraftError(metric, target, note);
    if (problem) {
      createError = problem;
      return;
    }
    creating = true;
    createError = null;
    try {
      await endpoints.createGoal({
        metric,
        target: Number(target),
        note: normalizeNote(note),
        targetDate: targetDateToUnix(targetDate),
      });
      target = "";
      note = "";
      targetDate = "";
      await load();
    } catch (err) {
      createError = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      creating = false;
    }
  }

  async function saveEdit(id: string) {
    const problem = targetError(editTarget) ?? noteError(editNote);
    if (problem) {
      actionError = problem;
      return;
    }
    busyId = id;
    actionError = null;
    try {
      await endpoints.updateGoal(id, {
        target: Number(editTarget),
        note: normalizeNote(editNote),
        targetDate: targetDateToUnix(editTargetDate),
      });
      editingId = null;
      await load();
    } catch (err) {
      actionError = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      busyId = null;
    }
  }

  async function setStatus(view: GoalView, status: "active" | "archived") {
    busyId = view.goal.id;
    actionError = null;
    try {
      await endpoints.updateGoal(view.goal.id, { status });
      if (editingId === view.goal.id) editingId = null;
      await load();
    } catch (err) {
      actionError = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      busyId = null;
    }
  }

  async function remove(view: GoalView) {
    if (!confirm("Delete this goal? This cannot be undone.")) return;
    busyId = view.goal.id;
    actionError = null;
    try {
      await endpoints.deleteGoal(view.goal.id);
      if (editingId === view.goal.id) editingId = null;
      await load();
    } catch (err) {
      actionError = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      busyId = null;
    }
  }
</script>

<svelte:head><title>Goals · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Intelligence · Goals"
    title="Goals"
    description="Set a target — TornScope projects when you'll reach it from your own recorded history. Projections, not predictions."
  >
    {#snippet actions()}
      <div class="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-1" role="group" aria-label="Projection window">
        {#each LOOKBACKS as days (days)}
          <button
            class="rounded-full px-3 py-1 text-xs font-medium transition-all {lookback === days ? 'bg-fg font-semibold text-bg' : 'text-fg-muted hover:text-fg'}"
            aria-pressed={lookback === days}
            title={`Project from the last ${days} days of history`}
            onclick={() => setLookback(days)}
          >
            {days} days
          </button>
        {/each}
      </div>
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load goals" hint={error} action={{ label: "Retry", run: () => void load() }} />
  {:else if data}
    {#if actionError}
      <div class="rounded-tile border border-negative/25 bg-negative/5 px-4 py-2.5 text-[13px] text-negative" role="alert">{actionError}</div>
    {/if}

    <!-- Create form -->
    <Panel title="New goal" caption="Goals read from data TornScope already stores — setting one never triggers extra Torn API calls">
      <form
        aria-label="New goal"
        class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        onsubmit={(e) => {
          e.preventDefault();
          void createGoal();
        }}
      >
        <label class="block text-xs text-fg-muted">
          <span class="mb-1 block">Metric</span>
          <select class="input w-full" bind:value={metric}>
            {#each data.metrics as m (m.id)}
              <option value={m.id}>{m.label}</option>
            {/each}
          </select>
        </label>
        <label class="block text-xs text-fg-muted">
          <span class="mb-1 block">Target</span>
          <input
            type="number"
            class="input tnum w-full"
            min="0"
            step="any"
            inputmode="decimal"
            placeholder={selectedUnit === "money" ? "e.g. 1500000" : "e.g. 2500"}
            aria-describedby="goal-target-preview"
            value={target}
            oninput={(e) => (target = (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="block text-xs text-fg-muted">
          <span class="mb-1 block">Note <span class="font-normal text-fg-faint">(optional)</span></span>
          <input type="text" class="input w-full" maxlength="280" placeholder="What is this goal for?" bind:value={note} />
        </label>
        <label class="block text-xs text-fg-muted">
          <span class="mb-1 block">Target date <span class="font-normal text-fg-faint">(optional)</span></span>
          <input type="date" class="input w-full [color-scheme:dark]" bind:value={targetDate} />
        </label>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-2 lg:col-span-4">
          <button type="submit" class="btn btn-accent btn-sm" disabled={creating}>
            {creating ? "Creating…" : "Create goal"}
          </button>
          <p id="goal-target-preview" class="text-[11px] text-fg-faint">
            {#if targetPreview}
              Reads as <span class="tnum text-fg-muted">{targetPreview}</span>
            {:else if selectedUnit === "money"}
              Enter the amount in Torn dollars.
            {/if}
          </p>
          {#if createError}
            <p class="text-xs text-negative" role="alert">{createError}</p>
          {/if}
        </div>
      </form>
      {#if selectedDescription}
        <p class="mt-2 text-[11px] leading-relaxed text-fg-faint">{selectedDescription}</p>
      {/if}
    </Panel>

    <!-- Goal cards -->
    <section aria-label="Your goals" class="space-y-4">
      {#if data.goals.length === 0}
        <StateMessage
          state="empty"
          title="No goals yet"
          hint="Set a target — TornScope projects when you'll get there from your own history."
        />
      {:else}
        {#if groups.active.length > 0}
          <div class="space-y-4">
            {#each groups.active as view (view.goal.id)}
              {@const unit = unitForMetric(data.metrics, view.goal.metric)}
              {@const label = metricLabel(data.metrics, view.goal.metric)}
              {@const pct = progressPct(view.progress)}
              {@const velocity = formatVelocity(view.projection.velocityPerDay, unit)}
              {@const chip = confidenceChip(view.projection.confidence)}
              <article class="min-w-0 rounded-card border border-border bg-surface p-5 shadow-panel">
                <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h3 class="text-[14px] font-semibold text-fg">{label}</h3>
                      {#if view.goal.status === "achieved"}
                        <span class="chip chip-positive !px-1.5 !text-[9px] !uppercase">Achieved</span>
                      {/if}
                      {#if view.goal.targetDate !== null}
                        <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">By {td.displayDate(view.goal.targetDate)}</span>
                      {/if}
                    </div>
                    {#if view.goal.note}
                      <p class="mt-0.5 text-xs leading-relaxed text-fg-muted">{view.goal.note}</p>
                    {/if}
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <button class="btn btn-sm" disabled={busyId === view.goal.id} onclick={() => startEdit(view)}>Edit</button>
                    <button class="btn btn-sm" disabled={busyId === view.goal.id} onclick={() => void setStatus(view, "archived")}>Archive</button>
                    <button class="btn btn-danger btn-sm" disabled={busyId === view.goal.id} onclick={() => void remove(view)}>Delete</button>
                  </div>
                </div>

                {#if editingId === view.goal.id}
                  <form
                    aria-label={`Edit ${label} goal`}
                    class="mt-4 grid gap-3 rounded-tile border border-border bg-bg-raise p-3 sm:grid-cols-3"
                    onsubmit={(e) => {
                      e.preventDefault();
                      void saveEdit(view.goal.id);
                    }}
                  >
                    <label class="block text-xs text-fg-muted">
                      <span class="mb-1 block">Target</span>
                      <input
                        type="number"
                        class="input tnum w-full"
                        min="0"
                        step="any"
                        inputmode="decimal"
                        value={editTarget}
                        oninput={(e) => (editTarget = (e.currentTarget as HTMLInputElement).value)}
                      />
                    </label>
                    <label class="block text-xs text-fg-muted">
                      <span class="mb-1 block">Note</span>
                      <input type="text" class="input w-full" maxlength="280" bind:value={editNote} />
                    </label>
                    <label class="block text-xs text-fg-muted">
                      <span class="mb-1 block">Target date</span>
                      <input type="date" class="input w-full [color-scheme:dark]" bind:value={editTargetDate} />
                    </label>
                    <div class="flex items-center gap-2 sm:col-span-3">
                      <button type="submit" class="btn btn-accent btn-sm" disabled={busyId === view.goal.id}>
                        {busyId === view.goal.id ? "Saving…" : "Save changes"}
                      </button>
                      <button type="button" class="btn btn-sm" onclick={cancelEdit}>Cancel</button>
                    </div>
                  </form>
                {:else}
                  <div class="mt-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    {#if view.currentValue !== null}
                      <span class="tnum text-2xl font-semibold leading-none text-fg">{formatGoalValue(view.currentValue, unit)}</span>
                      <span class="tnum text-[13px] text-fg-muted">of {formatGoalValue(view.goal.target, unit)} target</span>
                      <span class="text-[11px] text-fg-faint">{asOfLabel(view.currentValueAt, formatRelative)}</span>
                    {:else}
                      <span class="text-sm text-fg-faint">No data yet</span>
                      <span class="tnum text-[13px] text-fg-muted">target {formatGoalValue(view.goal.target, unit)}</span>
                    {/if}
                  </div>

                  {#if pct !== null}
                    <div class="mt-3 flex items-center gap-3">
                      <div
                        class="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"
                        role="progressbar"
                        aria-label={`${label} progress toward target`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                      >
                        <div class="h-full rounded-full {pct >= 100 ? 'bg-positive' : 'bg-accent/70'}" style={`width:${pct}%`}></div>
                      </div>
                      <span class="tnum w-10 text-right text-xs text-fg-muted">{pct}%</span>
                    </div>
                  {:else}
                    <p class="mt-3 text-xs text-fg-faint">Progress appears once this metric has recorded data.</p>
                  {/if}

                  <p class="mt-3 text-[13px]">
                    {#if view.projection.etaAt !== null && isStatProjection(view.projection.model)}
                      <!-- Stat goals (semantic audit): the ETA is a RANGE unless
                           confidence is high, the companion figure is the
                           DESCRIPTIVE recent growth, and the assumptions live in
                           a tooltip — no frozen gain/day presented as a promise. -->
                      <span class="font-medium text-fg">Projected: {formatEtaRange(view.projection.etaRangeDays) ?? td.displayDate(view.projection.etaAt)}</span>
                      {#if view.projection.observedChangePerDay !== null}
                        <span class="tnum text-fg-muted"> · recent growth {formatVelocity(view.projection.observedChangePerDay, unit)} (observed)</span>
                      {/if}
                      <span class={`chip ml-2 ${chip.class} !px-1.5 !text-[9px] !font-semibold !uppercase !tracking-wide`} title={chip.title}>{chip.label}</span>
                      <details class="mt-1.5 text-xs text-fg-faint">
                        <summary class="cursor-pointer select-none hover:text-fg-muted">Based on</summary>
                        <span>{STAT_PROJECTION_ASSUMPTIONS}</span>
                      </details>
                    {:else if view.projection.etaAt !== null}
                      <span class="font-medium text-fg">Projected: {td.displayDate(view.projection.etaAt)}</span>
                      {#if velocity}
                        <span class="tnum text-fg-muted"> · {velocity}</span>
                      {/if}
                      <span class={`chip ml-2 ${chip.class} !px-1.5 !text-[9px] !font-semibold !uppercase !tracking-wide`} title={chip.title}>{chip.label}</span>
                    {:else}
                      <span class="text-fg-muted">{insufficientReasonLabel(view.projection.insufficientReason)}</span>
                      {#if isStatProjection(view.projection.model) && view.projection.observedChangePerDay !== null}
                        <span class="tnum text-fg-faint"> · recent growth {formatVelocity(view.projection.observedChangePerDay, unit)} (observed)</span>
                      {/if}
                    {/if}
                  </p>
                {/if}
              </article>
            {/each}
          </div>
        {/if}

        {#if groups.archived.length > 0}
          <p class="section-label pt-2">Archived</p>
          <div class="space-y-2">
            {#each groups.archived as view (view.goal.id)}
              {@const label = metricLabel(data.metrics, view.goal.metric)}
              {@const unit = unitForMetric(data.metrics, view.goal.metric)}
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-tile border border-border/60 px-4 py-2.5">
                <span class="text-[13px] font-medium text-fg-muted">{label}</span>
                <span class="tnum text-[11px] text-fg-faint">target {formatGoalValue(view.goal.target, unit)}</span>
                <span class="chip chip-quiet !px-1.5 !text-[9px] !uppercase">Archived</span>
                <div class="ml-auto flex items-center gap-2">
                  <button class="btn btn-sm" disabled={busyId === view.goal.id} onclick={() => void setStatus(view, "active")}>Unarchive</button>
                  <button class="btn btn-danger btn-sm" disabled={busyId === view.goal.id} onclick={() => void remove(view)}>Delete</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        <p class="flex flex-wrap items-center gap-x-2 text-[11px] text-fg-faint">
          <span class="tnum">{data.goals.length}</span>
          <span>goal{data.goals.length === 1 ? "" : "s"} · projections use the last {lookback} days of your recorded history ·</span>
          <ProvenanceBadge level="derived" />
          <span>projections, not predictions</span>
        </p>
      {/if}
    </section>
  {/if}
</div>
