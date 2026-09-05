<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { endpoints, ApiClientError } from "$lib/api";
  import type { ApiKeyStatusResponse } from "@tornscope/shared";
  import { branding } from "@tornscope/shared";
  import { refreshMe, me } from "$lib/state.svelte";

  let apiKey = $state("");
  let validating = $state(false);
  let loadingDemo = $state(false);
  let error = $state<string | null>(null);
  let status = $state<ApiKeyStatusResponse | null>(null);
  let step = $state(1);

  // Step 3 progress (resource-level — never an invented overall percentage).
  type ResourceRow = { resource: string; status: string; lastSuccessAt: number | null; recordsCollected: number; errorMessage: string | null };
  let syncRows = $state<ResourceRow[]>([]);
  let syncRunning = $state(false);
  let retrying = $state(false);

  const RESOURCE_LABELS: Record<string, string> = {
    profile: "Profile",
    networth: "Net worth",
    personal_stats: "Stats",
    drugs: "Drugs",
    rehab: "Rehab",
    money_logs: "Money",
    travel: "Travel",
    events: "Timeline",
    faction_basic: "Faction",
    torn_catalog: "Catalog",
  };

  async function validateAndSave() {
    if (apiKey.trim().length < 10) {
      error = "That doesn't look like a valid Torn API key.";
      return;
    }
    validating = true;
    error = null;
    try {
      // The backend validates, stores the encrypted credential, detects the
      // player and queues the initial backfill itself.
      status = await endpoints.saveApiKey(apiKey.trim());
      apiKey = "";
      await refreshMe(); // drop stale "not configured" state immediately
      step = 3;
      void pollSync();
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      validating = false;
    }
  }

  async function pollSync() {
    try {
      const s = await endpoints.syncStatus();
      syncRunning = s.running;
      syncRows = s.resources as ResourceRow[];
    } catch {
      // Progress is best-effort; the button below never depends on it.
    }
  }

  function rowState(row: ResourceRow): { label: string; cls: string } {
    if (row.status === "running") return { label: row.lastSuccessAt === null ? "importing" : "syncing", cls: "text-accent" };
    if (row.errorMessage && row.lastSuccessAt === null) return { label: "failed", cls: "text-negative" };
    if (row.lastSuccessAt !== null) {
      return { label: row.recordsCollected > 0 ? `ready · ${row.recordsCollected.toLocaleString("en-US")} records` : "ready", cls: "text-positive" };
    }
    return { label: "queued", cls: "text-fg-faint" };
  }

  async function retryFailed() {
    retrying = true;
    try {
      await endpoints.syncRetryFailed();
      void pollSync();
    } catch {
      // surfaced on the Sync Status page
    } finally {
      retrying = false;
    }
  }

  async function exploreDemo() {
    loadingDemo = true;
    error = null;
    try {
      await endpoints.setDemoView(true);
      await refreshMe();
      await goto("/today");
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      loadingDemo = false;
    }
  }

  function openApp() {
    void goto("/today");
  }

  onMount(() => {
    const poll = setInterval(() => {
      if (step === 3) void pollSync();
    }, 3000);
    return () => clearInterval(poll);
  });
</script>

<div class="flex min-h-screen items-center justify-center px-5 py-14">
  <div class="w-full max-w-xl space-y-10">
    <div class="space-y-3 text-center">
      <a href="/" class="inline-flex items-center gap-2.5">
        <span class="h-2 w-2 rounded-full bg-accent shadow-glow"></span>
        <span class="text-[15px] font-semibold tracking-tight text-fg">TornScope</span>
      </a>
      <h1 class="font-display text-5xl font-medium leading-tight text-fg">
        A private record of<br />your <span class="italic text-accent">Torn life</span>.
      </h1>
      <p class="mx-auto max-w-md text-sm leading-relaxed text-fg-muted">
        {branding.tagline} — continuously collected, normalized and stored on your own server, from the very first sync onward.
      </p>
    </div>

    <div class="rounded-2xl border border-border bg-surface p-7 shadow-panel">
      {#if step === 1}
        <label class="mb-2.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint" for="api-key">Torn API key</label>
        <input
          id="api-key"
          type="password"
          bind:value={apiKey}
          placeholder="Paste your Full Access API key"
          class="w-full rounded-xl border border-border bg-bg-raise px-4 py-3 font-mono text-sm text-fg placeholder:font-sans placeholder:text-fg-faint focus:border-accent"
          autocomplete="off"
        />
        {#if error}
          <p class="mt-2.5 text-sm text-negative">{error}</p>
        {/if}
        <button
          class="mt-5 w-full rounded-xl bg-accent-strong py-3 text-sm font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40"
          disabled={validating}
          onclick={() => void validateAndSave()}
        >
          {validating ? "Validating with Torn…" : "Validate & start tracking"}
        </button>
        <p class="mt-3 text-center text-xs text-fg-faint">
          Get your key at <span class="font-mono text-fg-muted">torn.com/preferences.php#tab=api</span>
        </p>

        <div class="my-6 flex items-center gap-4">
          <span class="h-px flex-1 bg-border"></span>
          <span class="text-[10px] uppercase tracking-[0.18em] text-fg-faint">or</span>
          <span class="h-px flex-1 bg-border"></span>
        </div>

        <button
          class="w-full rounded-xl border border-border-strong py-3 text-sm font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
          disabled={loadingDemo}
          onclick={() => void exploreDemo()}
        >
          {loadingDemo ? "Preparing demo…" : "Explore with demo data first"}
        </button>
        {#if !error}
          <p class="mt-3 text-center text-xs text-fg-faint">Seeded example player, clearly marked — switch to your own data whenever you're ready.</p>
        {/if}
      {:else if step === 2}
        <div class="flex flex-col items-center gap-4 py-6">
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-border-strong border-t-accent"></div>
          <p class="text-sm text-fg-muted">Key saved. Kicking off the initial sync of your Torn history…</p>
        </div>
      {:else}
        <div class="space-y-5">
          <div class="space-y-1 text-center">
            <p class="text-sm font-semibold text-positive">Account connected — live data is available.</p>
            <p class="mx-auto max-w-sm text-[13px] leading-relaxed text-fg-muted">
              You can start exploring now; the historical import continues in the background.
            </p>
          </div>

          <!-- Resource-level progress (no invented overall percentage) -->
          <div class="rounded-xl border border-border bg-bg-raise px-4 py-2">
            {#each syncRows as row (row.resource)}
              <div class="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
                <span class="text-[13px] text-fg">{RESOURCE_LABELS[row.resource] ?? row.resource}</span>
                <span class="tnum text-xs {rowState(row).cls}">{rowState(row).label}</span>
              </div>
            {:else}
              <p class="py-3 text-center text-xs text-fg-faint">
                {syncRunning ? "Starting the initial sync…" : "Waiting for the first sync…"}
              </p>
            {/each}
          </div>

          <button class="w-full rounded-xl bg-accent-strong py-3 text-sm font-semibold text-bg transition-colors hover:bg-accent" onclick={openApp}>
            Open Today
          </button>
          <div class="flex items-center justify-center gap-4 text-xs">
            <a href="/sync" class="text-fg-muted transition-colors hover:text-accent">Sync status</a>
            {#if syncRows.some((r) => r.errorMessage && r.lastSuccessAt === null)}
              <button class="text-fg-muted transition-colors hover:text-accent disabled:opacity-40" onclick={() => void retryFailed()} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry failed sync"}
              </button>
            {/if}
          </div>
          {#if me.data?.torn}
            <p class="text-center text-xs text-fg-faint">Detected player: {me.data.torn.name} [{me.data.torn.tornId}]</p>
          {/if}
        </div>
      {/if}
    </div>

    {#if step !== 3 && status?.tornId}
      <p class="text-center text-xs text-fg-muted">
        Detected player: <span class="text-fg">{status.tornName}</span> [{status.tornId}]
      </p>
    {/if}
  </div>
</div>
