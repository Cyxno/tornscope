<script lang="ts">
  import { initAppearance } from "$lib/appearance-state.svelte";
  import "@fontsource-variable/inter";
  import "@fontsource-variable/newsreader";
  import "@fontsource-variable/newsreader/wght-italic.css";
  import "../app.css";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Header from "$lib/components/Header.svelte";
  import NavRail from "$lib/components/NavRail.svelte";
  import MobileNav from "$lib/components/MobileNav.svelte";
  import { me, refreshMe } from "$lib/state.svelte";
  import { endpoints } from "$lib/api";
  import { env as publicEnv } from "$env/dynamic/public";
  import InstallHint from "$lib/components/InstallHint.svelte";
  import { registerServiceWorker } from "$lib/pwa";

  initAppearance();

  // Footer status label mirrors the header chip: production shows "Public
  // Beta"; non-production deployments set PUBLIC_ENV_LABEL (e.g. "Development")
  // and the footer reports that environment instead.
  const statusLabel = publicEnv.PUBLIC_ENV_LABEL?.trim() || "Production";

  let { children } = $props();

  onMount(() => {
    void refreshMe();
    // The push-only service worker registers at startup (not only from the
    // notification settings): an installed iOS web app must be able to
    // subscribe right after install, and updates apply on next navigation.
    void registerServiceWorker();
  });

  // First-run flow: without a connected Torn player, route to /welcome.
  // Settings stays reachable — key management lives there too.
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

<div class="app-backdrop flex min-h-screen">
  <!-- Option B shell: the rail owns desktop navigation; everything below lg
       uses the compact context bar + bottom tab bar. -->
  <NavRail />

  <div class="flex min-w-0 flex-1 flex-col">
    <Header />

    {#if me.data?.isDemo}
      <div class="border-b border-border bg-bg-raise">
        <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2 text-xs sm:px-6">
          <p class="flex min-w-0 items-center gap-2 text-fg-muted">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"></span>
            <span class="truncate">Demo mode — synthetic seed data, kept separate from any real player account.</span>
          </p>
          <button class="btn btn-sm shrink-0" onclick={() => void exitDemo()}>Exit demo</button>
        </div>
      </div>
    {/if}

    <main class="page-shell w-full flex-1">
      {#if me.loaded && me.error}
        <div class="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-tile border border-negative/25 bg-negative/5 px-5 py-3">
          <p class="text-[13px] text-negative">Could not reach the TornScope API: {me.error}</p>
          <button class="btn btn-sm" onclick={() => void refreshMe()}>Retry</button>
        </div>
      {/if}
      {@render children()}
    </main>
    <div class="page-shell mb-6 lg:mb-0 lg:pb-6">
      <!-- Contextual install hint: iPhone/iPad browsers get the guided
           Add to Home Screen flow, install-capable browsers get the native
           prompt; hidden when installed or dismissed. -->
      <InstallHint />
    </div>

    <footer class="border-t border-border pb-16 lg:pb-0">
      <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs text-fg-faint sm:px-6">
        <p>
          TornScope — a private record of your Torn life.
          <span class="text-fg-muted">{statusLabel}</span> · maintained by
          <a
            href="https://www.torn.com/profiles.php?XID=1816206"
            target="_blank"
            rel="noopener noreferrer"
            class="underline decoration-border underline-offset-2 transition-colors hover:text-fg-muted hover:decoration-fg-faint"
            title="Contact Cyxno on Torn — help, bug reports, private Docker deployments"
          >Cyxno</a>. Your data stays on the TornScope server hosting this instance.
        </p>
        <p class="flex items-center gap-3">
          <a href="/sync" class="transition-colors hover:text-fg-muted">Sync</a>
          <a href="/settings" class="transition-colors hover:text-fg-muted">Settings</a>
          <a
            href="https://www.torn.com/profiles.php?XID=1816206"
            target="_blank"
            rel="noopener noreferrer"
            class="transition-colors hover:text-fg-muted"
            title="Help, beta feedback or a private TornScope Docker deployment"
          >Contact</a>
        </p>
      </div>
    </footer>
  </div>

  <MobileNav />
</div>
