<script lang="ts">
  import "@fontsource-variable/inter";
  import "@fontsource-variable/newsreader";
  import "@fontsource-variable/newsreader/wght-italic.css";
  import "../app.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Header from "$lib/components/Header.svelte";
  import { me, refreshMe } from "$lib/state.svelte";
  import { endpoints } from "$lib/api";

  let { children } = $props();

  onMount(() => {
    void refreshMe();
  });

  // First-run flow: without a connected Torn player, route to /welcome.
  // Settings stays reachable — it hosts the legacy owner recovery flow.
  $effect(() => {
    if (
      me.loaded &&
      me.data?.needsOnboarding &&
      page.url.pathname !== "/welcome" &&
      page.url.pathname !== "/settings"
    ) {
      void goto("/welcome");
    }
  });

  async function exitDemo() {
    try {
      await endpoints.setDemoView(false);
      await refreshMe();
      await goto("/");
    } catch (err) {
      // Leaving demo must not die silently (an unhandled rejection would keep
      // the banner up with no feedback); surface why it failed.
      console.error("exitDemo failed", err);
      alert(err instanceof Error ? err.message : "Could not leave demo view — try again.");
    }
  }
</script>

<div class="app-backdrop flex min-h-screen flex-col">
  <Header />

  {#if me.data?.isDemo}
    <div class="border-b border-border bg-bg-raise">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-2 text-xs">
        <p class="text-fg-muted">
          <span class="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-warning"></span>
          Demo mode — synthetic seed data, kept separate from any real player account.
        </p>
        <button class="rounded-full border border-border-strong px-3 py-1 text-xs text-fg-muted transition-colors hover:border-accent hover:text-accent" onclick={() => void exitDemo()}>
          Exit demo
        </button>
      </div>
    </div>
  {/if}

  <main class="mx-auto w-full max-w-6xl flex-1 px-5 py-10 sm:px-6 sm:py-12">
    {#if me.loaded && me.error}
      <div class="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-negative/25 bg-negative/5 px-5 py-3">
        <p class="text-[13px] text-negative">Could not reach the TornScope API: {me.error}</p>
        <button class="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent" onclick={() => void refreshMe()}>
          Retry
        </button>
      </div>
    {/if}
    {@render children()}
  </main>

  <footer class="border-t border-border">
    <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-5 py-5 text-xs text-fg-faint sm:px-6">
      <p>TornScope — a private record of your Torn life. Your data stays on the TornScope server hosting this instance.</p>
      <p class="flex items-center gap-3">
        <a href="/sync" class="transition-colors hover:text-fg-muted">Sync</a>
        <a href="/settings" class="transition-colors hover:text-fg-muted">Settings</a>
      </p>
    </div>
  </footer>
</div>
