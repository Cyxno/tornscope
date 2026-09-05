<script lang="ts">
  import { onMount } from "svelte";
  import {
    remainingSeconds,
    formatCountdownCompact,
    formatMoneyFull,
    type LiveBar,
    type TodayResponse,
  } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { me } from "$lib/state.svelte";
  import { formatDateTimeInZone, greetingForHour } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import Countdown from "$lib/components/Countdown.svelte";

  /**
   * Today — live account status.
   * The backend returns absolute timestamps once per cache window; everything
   * on this page counts down locally against server-skew-corrected time.
   * Polling pauses while the tab is hidden and refreshes on return.
   */

  const POLL_MS = 45_000;

  let data = $state<TodayResponse | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state<string | null>(null);

  let nowMs = $state(Date.now());
  let offsetMs = $state(0); // server clock minus client clock

  const timeZone = $derived(me.data?.timezone || "UTC");
  const serverNowMs = $derived(nowMs + offsetMs);

  async function load() {
    refreshing = true;
    try {
      data = await endpoints.today();
      offsetMs = data.fetchedAt - Date.now();
      error = null;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  onMount(() => {
    void load();
    const ticker = setInterval(() => (nowMs = Date.now()), 1000);
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (poll === null) poll = setInterval(() => void load(), POLL_MS);
    };
    const stopPolling = () => {
      if (poll !== null) {
        clearInterval(poll);
        poll = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else {
        void load();
        startPolling();
      }
    };
    startPolling();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(ticker);
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });

  /* ------------------------------------------------------------------ */
  /* Derived presentation helpers                                        */
  /* ------------------------------------------------------------------ */

  const greeting = $derived(greetingForHour(new Date(serverNowMs).getUTCHours()));

  const statusLine = $derived.by(() => {
    if (!data) return "";
    const s = data.player.status;
    const state = s.description || s.details || s.state;
    return [state, data.player.level !== null ? `Level ${data.player.level}` : null].filter(Boolean).join(" · ");
  });

  const bars = $derived.by(() => {
    if (!data) return [];
    return [data.bars.energy, data.bars.nerve, data.bars.happy, data.bars.life] as Array<LiveBar | null>;
  });

  function barState(bar: LiveBar | null): { text: string; tone: "muted" | "positive" | "warning" | "accent" } {
    if (!bar) return { text: "Unavailable", tone: "muted" };
    if (bar.regenState === "full") return { text: "Full", tone: "positive" };
    if (bar.regenState === "regenerating" && bar.fullAt !== null) {
      return { text: `Full in ${formatCountdownCompact(remainingSeconds(serverNowMs, bar.fullAt))}`, tone: "accent" };
    }
    return { text: "Regen paused", tone: "warning" };
  }

  function fmtFullAt(bar: LiveBar | null): string {
    if (!bar || bar.regenState !== "regenerating" || bar.fullAt === null) return "";
    return ` · ${formatDateTimeInZone(bar.fullAt, timeZone)}`;
  }

  const travel = $derived(data?.travel ?? null);
  const travelHeadline = $derived.by(() => {
    if (!travel) return "—";
    if (travel.state === "traveling") return travel.direction === "returning" ? "Returning home" : (travel.country ?? "Traveling");
    if (travel.state === "abroad") return travel.country ?? "Abroad";
    if (travel.state === "home") return "At home";
    return "Unavailable";
  });
  const travelSub = $derived.by(() => {
    if (!travel) return "";
    if (travel.state === "traveling") {
      return travel.direction === "returning" ? `Flying home from ${travel.country ?? "abroad"}` : `Flying to ${travel.country ?? "destination"}`;
    }
    if (travel.state === "abroad") return `Staying in ${travel.country ?? "abroad"}`;
    if (travel.state === "home") return "No flight in progress";
    return travel.requiredAccess ? `Requires ${travel.requiredAccess} API access` : "Live travel data unavailable";
  });

  const flightProgress = $derived.by(() => {
    if (!travel || travel.state !== "traveling" || travel.departedAt === null || travel.landsAt === null) return null;
    const span = travel.landsAt - travel.departedAt;
    if (span <= 0) return null;
    return Math.min(100, Math.max(0, ((serverNowMs / 1000 - travel.departedAt) / span) * 100));
  });

  const cooldowns = $derived.by(() => {
    if (!data) return [];
    return [data.cooldowns.drug, data.cooldowns.booster, data.cooldowns.medical] as const;
  });

  const bank = $derived(data?.bank ?? null);
  const education = $derived(data?.education ?? null);

  const upcoming = $derived(data?.upcoming ?? []);

  const severityDot: Record<string, string> = {
    info: "bg-fg-faint",
    success: "bg-positive",
    warning: "bg-warning",
    critical: "bg-negative",
  };

  const updatedAgo = $derived.by(() => {
    if (!data) return "";
    const diff = Math.max(0, Math.floor((serverNowMs - data.fetchedAt) / 1000));
    if (diff < 5) return "just now";
    if (diff < 60) return `${diff}s ago`;
    return `${Math.floor(diff / 60)}m ago`;
  });
</script>

<div class="space-y-10">
  <PageHeader eyebrow="Live status" title="Today" description="Everything that matters right now.">
    {#snippet actions()}
      <div class="flex items-center gap-3">
        {#if data?.demo}
          <span class="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-warning">
            <span class="h-1.5 w-1.5 rounded-full bg-warning"></span>
            Demo — simulated
          </span>
        {/if}
        {#if data}
          <span class="hidden text-xs text-fg-faint sm:inline">Updated {updatedAgo}</span>
        {/if}
        <button
          class="rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          onclick={() => void load()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    {/snippet}
  </PageHeader>

  {#if loading && !data}
    <StateMessage state="loading" />
  {:else if error && !data}
    <StateMessage
      state="error"
      title="Could not load live status"
      hint={me.data?.isDemo ? "Live status needs a real Torn API key — the demo dataset only contains historical data. Connect your key in Settings to go live." : error}
      action={{ label: "Retry", run: () => void load() }}
    />
  {:else if data}
    <!-- Hospital / jail: highest priority notices -->
    {#if data.hospital || data.jail}
      <div class="space-y-3">
        {#each [data.hospital, data.jail] as notice, i (i)}
          {#if notice}
            <div class="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border px-5 py-4 {notice.kind === 'hospital' ? 'border-negative/30 bg-negative/5' : 'border-warning/30 bg-warning/5'}">
              <span class="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] {notice.kind === 'hospital' ? 'text-negative' : 'text-warning'}">
                <span class="h-1.5 w-1.5 rounded-full {notice.kind === 'hospital' ? 'bg-negative' : 'bg-warning'} live-dot"></span>
                {notice.kind}
              </span>
              <span class="tnum text-sm font-semibold text-fg">
                {#if notice.releasedAt !== null}
                  Released in <Countdown seconds={remainingSeconds(serverNowMs, notice.releasedAt)} style="compact" />
                {:else}
                  Held indefinitely
                {/if}
              </span>
              {#if notice.reason}
                <span class="text-xs text-fg-muted">{notice.reason}</span>
              {/if}
              {#if notice.releasedAt !== null}
                <span class="tnum text-xs text-fg-faint">at {formatDateTimeInZone(notice.releasedAt, timeZone)}</span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- Greeting / current account state -->
    <div class="space-y-1.5">
      <p class="font-display text-3xl font-medium leading-tight text-fg">
        {greeting}{data.player.name ? `, ${data.player.name}` : ""}.
      </p>
      <p class="text-sm text-fg-muted">{statusLine}</p>
    </div>

    <!-- LIVE STATE: the four bars -->
    <section aria-label="Live bars" class="rounded-2xl border border-border bg-surface px-5 py-2 shadow-panel sm:px-7">
      <p class="pt-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-faint">Live state</p>
      <div>
        {#each bars as bar, i (i)}
          <div class="flex flex-col gap-2 border-b border-border/60 py-4 last:border-0 md:flex-row md:items-center md:gap-6">
            <span class="w-20 shrink-0 text-[13px] font-medium text-fg">{bar?.label ?? "—"}</span>
            {#if bar}
              <div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={bar.label} aria-valuenow={bar.percent} aria-valuemin={0} aria-valuemax={100}>
                <div
                  class="h-full rounded-full {bar.regenState === 'paused' ? 'bg-warning/70' : 'bg-gradient-to-r from-accent-strong to-accent'}"
                  style={`width:${Math.min(100, Math.max(2, bar.percent))}%`}
                ></div>
              </div>
              <span class="tnum shrink-0 text-[13px] text-fg-muted md:w-44 md:text-right">
                {bar.current.toLocaleString("en-US")} / {bar.max.toLocaleString("en-US")}
                <span class="text-fg-faint">· {Math.round(bar.percent)}%</span>
              </span>
              <span class="tnum shrink-0 text-[13px] font-medium md:w-32 md:text-right {barState(bar).tone === 'positive' ? 'text-positive' : barState(bar).tone === 'warning' ? 'text-warning' : barState(bar).tone === 'accent' ? 'text-accent' : 'text-fg-faint'}">
                {barState(bar).text}
              </span>
            {:else}
              <span class="text-[13px] text-fg-faint">Bars unavailable — this needs a Minimal access API key.</span>
            {/if}
          </div>
        {/each}
      </div>
    </section>

    <!-- Travel + cooldowns -->
    <section class="grid gap-6 lg:grid-cols-5">
      <div class="lg:col-span-3">
        <Panel title="Travel" caption="Where you are, and what is in the air">
          {#snippet actions()}
            <a class="text-xs text-fg-faint transition-colors hover:text-accent" href="https://www.torn.com/travel.php" target="_blank" rel="noopener noreferrer">Torn ↗</a>
          {/snippet}
          <div class="space-y-3">
            <p class="font-display text-3xl font-medium text-fg">{travelHeadline}</p>
            <p class="text-sm text-fg-muted">{travelSub}</p>
            {#if travel?.state === "traveling" && travel.landsAt !== null}
              <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 pt-1">
                <span class="text-[13px] font-medium text-fg-muted">
                  {travel.direction === "returning" ? "Home in" : "Landing in"}
                </span>
                <span class="tnum text-xl font-semibold text-accent">
                  <Countdown seconds={remainingSeconds(serverNowMs, travel.landsAt)} style="clock" />
                </span>
                <span class="tnum text-xs text-fg-faint">at {formatDateTimeInZone(travel.landsAt, timeZone)}</span>
              </div>
              {#if flightProgress !== null}
                <div class="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                  <div class="h-full rounded-full bg-accent/70" style={`width:${flightProgress}%`}></div>
                </div>
                <div class="mt-1 flex justify-between text-[11px] text-fg-faint">
                  <span>{travel.departedAt !== null ? formatDateTimeInZone(travel.departedAt, timeZone) : ""}</span>
                  {#if travel.durationSeconds}
                    <span>flight {Math.round(travel.durationSeconds / 60)}m</span>
                  {/if}
                  <span>{formatDateTimeInZone(travel.landsAt, timeZone)}</span>
                </div>
              {/if}
            {/if}
            {#if travel?.state === "unavailable"}
              <p class="text-[13px] text-warning">{travel.unavailableReason ?? "Live travel data is unavailable."}</p>
            {/if}
          </div>
        </Panel>
      </div>

      <div class="lg:col-span-2">
        <Panel title="Cooldowns" caption="Ready when the clock hits zero" flush>
          <div class="px-6 pb-6 pt-3">
            {#each cooldowns as cd, i (i)}
              <div class="flex items-center justify-between gap-3 border-b border-border/60 py-3.5 last:border-0">
                <span class="text-[13px] font-medium text-fg">{cd?.label ?? "—"}</span>
                {#if cd}
                  {#if cd.state === "ready"}
                    <span class="inline-flex items-center gap-1.5 rounded-full border border-positive/30 bg-positive/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-positive">
                      Ready
                    </span>
                  {:else}
                    <span class="tnum text-[15px] font-semibold text-fg">
                      <Countdown seconds={remainingSeconds(serverNowMs, cd.endsAt)} style="clock" />
                    </span>
                  {/if}
                {:else}
                  <span class="text-[13px] text-fg-faint">Unavailable</span>
                {/if}
              </div>
            {/each}
          </div>
        </Panel>
      </div>
    </section>

    <!-- Longer-term: bank + education -->
    <section class="grid gap-6 lg:grid-cols-2">
      <Panel title="Bank investment" caption="City bank position">
        {#snippet actions()}
          <a class="text-xs text-fg-faint transition-colors hover:text-accent" href="https://www.torn.com/bank.php" target="_blank" rel="noopener noreferrer">Torn ↗</a>
        {/snippet}
        {#if bank?.state === "active" || bank?.state === "mature"}
          <div class="space-y-2">
            <p class="tnum font-display text-3xl font-medium text-fg">{formatMoneyFull(bank.amount)}</p>
            {#if bank.state === "mature"}
              <p class="text-sm font-semibold text-positive">Ready to collect</p>
            {:else if bank.maturesAt !== null}
              <p class="text-sm text-fg-muted">
                Matures in
                <span class="tnum font-semibold text-fg"><Countdown seconds={remainingSeconds(serverNowMs, bank.maturesAt)} style="compact" /></span>
                <span class="tnum text-xs text-fg-faint">· {formatDateTimeInZone(bank.maturesAt, timeZone)}</span>
              </p>
            {/if}
            {#if bank.interestRate !== null || bank.durationDays !== null}
              <p class="tnum text-xs text-fg-faint">
                {#if bank.interestRate !== null}{bank.interestRate}% interest{/if}
                {#if bank.durationDays !== null}{bank.interestRate !== null ? " · " : ""}{bank.durationDays} days{/if}
                {#if bank.profit !== null} · expected profit {formatMoneyFull(bank.profit)}{/if}
              </p>
            {/if}
          </div>
        {:else if bank?.state === "none"}
          <p class="text-sm text-fg-muted">No active investment.</p>
        {:else if bank}
          <p class="text-sm text-warning">{bank.requiredAccess ? `This requires ${bank.requiredAccess} access.` : (bank.unavailableReason ?? "Bank data unavailable.")}</p>
        {:else}
          <p class="text-sm text-fg-muted">—</p>
        {/if}
      </Panel>

      <Panel title="Education" caption="Current course">
        {#snippet actions()}
          <a class="text-xs text-fg-faint transition-colors hover:text-accent" href="https://www.torn.com/education.php" target="_blank" rel="noopener noreferrer">Torn ↗</a>
        {/snippet}
        {#if education?.state === "active" || education?.state === "complete"}
          <div class="space-y-2">
            <p class="font-display text-2xl font-medium text-fg">{education.courseName ?? "Course in progress"}</p>
            {#if education.categoryName}
              <p class="text-xs uppercase tracking-[0.14em] text-fg-faint">{education.categoryName}</p>
            {/if}
            {#if education.state === "complete"}
              <p class="text-sm font-semibold text-positive">Course complete</p>
            {:else if education.completesAt !== null}
              <p class="text-sm text-fg-muted">
                <span class="tnum font-semibold text-fg"><Countdown seconds={remainingSeconds(serverNowMs, education.completesAt)} style="compact" /></span>
                remaining
                <span class="tnum text-xs text-fg-faint">· {formatDateTimeInZone(education.completesAt, timeZone)}</span>
              </p>
            {/if}
          </div>
        {:else if education?.state === "none"}
          <p class="text-sm text-fg-muted">No active course.</p>
        {:else if education}
          <p class="text-sm text-warning">{education.requiredAccess ? `This requires ${education.requiredAccess} access.` : (education.unavailableReason ?? "Education data unavailable.")}</p>
        {:else}
          <p class="text-sm text-fg-muted">—</p>
        {/if}
      </Panel>
    </section>

    <!-- Upcoming: one merged chronological list -->
    <Panel title="Upcoming" caption="Everything on your account clock, soonest first" flush>
      <div class="px-6 pb-6 pt-3">
        {#if upcoming.length === 0}
          <p class="py-6 text-center text-[13px] text-fg-faint">Nothing scheduled — everything is ready.</p>
        {:else}
          <div>
            {#each upcoming as event (event.id)}
              <div class="flex items-center gap-3 border-b border-border/60 py-3 last:border-0">
                <span class={`h-1.5 w-1.5 shrink-0 rounded-full ${severityDot[event.severity]}`}></span>
                <span class="min-w-0 flex-1 truncate text-[13.5px] text-fg">{event.title}</span>
                <span class="tnum hidden shrink-0 text-xs text-fg-faint sm:inline">{formatDateTimeInZone(event.at, timeZone)}</span>
                <span class="tnum w-20 shrink-0 text-right text-[13px] font-semibold text-fg">
                  <Countdown seconds={remainingSeconds(serverNowMs, event.at)} style="compact" />
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </Panel>

    <p class="text-center text-[11px] text-fg-faint">
      Countdowns run in your browser from Torn's absolute timestamps · live state refreshes every {Math.round(POLL_MS / 1000)}s while the tab is open.
    </p>
  {/if}
</div>
