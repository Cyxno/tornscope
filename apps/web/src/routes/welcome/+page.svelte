<script lang="ts">
  import { goto } from "$app/navigation";
  import { endpoints, ApiClientError } from "$lib/api";
  import type { ApiKeyStatusResponse } from "@tornscope/shared";
  import { branding } from "@tornscope/shared";
  import { refreshMe } from "$lib/state.svelte";

  let apiKey = $state("");
  let validating = $state(false);
  let loadingDemo = $state(false);
  let error = $state<string | null>(null);
  let status = $state<ApiKeyStatusResponse | null>(null);
  let step = $state(1);

  async function validateAndSave() {
    if (apiKey.trim().length < 10) {
      error = "That doesn't look like a valid Torn API key.";
      return;
    }
    validating = true;
    error = null;
    try {
      status = await endpoints.saveApiKey(apiKey.trim());
      step = 2;
      await Promise.allSettled(
        ["profile", "networth", "personal_stats", "drugs", "travel", "rehab", "money_logs", "events", "faction_basic", "torn_catalog"].map((r) => endpoints.syncRun(r))
      );
      step = 3;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      validating = false;
    }
  }

  async function exploreDemo() {
    loadingDemo = true;
    error = null;
    try {
      await endpoints.setDemoView(true);
      await refreshMe();
      await goto("/");
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      loadingDemo = false;
    }
  }

  async function toDashboard() {
    await goto("/");
  }
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
        <div class="space-y-4 text-center">
          <p class="text-sm font-semibold text-positive">Initial sync queued.</p>
          <p class="mx-auto max-w-sm text-[13px] leading-relaxed text-fg-muted">
            The worker is collecting up to 180 days of logs. The dashboard fills in as data arrives — watch Sync Status for progress.
          </p>
          <button class="rounded-xl bg-accent-strong px-8 py-3 text-sm font-semibold text-bg transition-colors hover:bg-accent" onclick={() => void toDashboard()}>
            Go to dashboard
          </button>
        </div>
      {/if}
    </div>

    {#if status?.tornId}
      <p class="text-center text-xs text-fg-muted">
        Detected player: <span class="text-fg">{status.tornName}</span> [{status.tornId}]
      </p>
    {/if}
  </div>
</div>
