<script lang="ts">
  import { onMount } from "svelte";
  import {
    dismissInstallHint,
    installHintDismissed,
    isIOS,
    isStandalone,
    onBeforeInstallPrompt,
    onInstalled,
    type BeforeInstallPromptEvent,
  } from "$lib/pwa";

  /**
   * Contextual install hint (real-user remediation, iOS findings).
   * - iPhone/iPad in a browser tab: guided "Add to Home Screen" — install
   *   unlocks the app-like experience and (iOS 16.4+) Web Push.
   * - Chromium/desktop: a native install control when the browser fires
   *   `beforeinstallprompt`.
   * Never shows when already installed (standalone or appinstalled), never
   * persists after dismissal, and never renders a dead button on platforms
   * without an install flow.
   */

  let deferredPrompt = $state<BeforeInstallPromptEvent | null>(null);
  let showIOSHint = $state(false);
  let visible = $state(false);
  let installing = $state(false);
  let installed = $state(false);
  const secure = $derived(typeof window !== "undefined" && window.isSecureContext);

  onMount(() => {
    installed = isStandalone();
    const cleanupPrompt = onBeforeInstallPrompt((event) => {
      deferredPrompt = event;
      if (!installed && !installHintDismissed()) visible = true;
    });
    const cleanupInstalled = onInstalled(() => {
      installed = true;
      visible = false;
      showIOSHint = false;
    });
    // iOS never fires beforeinstallprompt — the guided hint is the flow.
    if (isIOS() && !isStandalone() && !installHintDismissed()) {
      showIOSHint = true;
      visible = true;
    }
    // Standalone display-mode can change without an appinstalled event
    // (relaunch after install) — re-check before showing anything.
    if (installed) visible = false;
    return () => {
      cleanupPrompt();
      cleanupInstalled();
    };
  });

  function dismiss(): void {
    visible = false;
    dismissInstallHint();
  }

  async function nativeInstall(): Promise<void> {
    if (!deferredPrompt) return;
    installing = true;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") visible = false;
      deferredPrompt = null;
    } finally {
      installing = false;
    }
  }
</script>

{#if visible && !installed}
  <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-tile border border-accent/30 bg-accent/5 px-5 py-4" role="complementary" aria-label="Install TornScope">
    <div class="min-w-0 text-[13px] leading-relaxed">
      <p class="font-medium text-fg">Install TornScope</p>
      {#if showIOSHint}
        <p class="mt-1 text-fg-muted">
          Add TornScope to your Home Screen for an app-like experience{secure ? " and notifications" : ""}.
          On iPhone: tap <span class="font-medium text-fg">Share</span> (the square with the arrow pointing
          out), then choose <span class="font-medium text-fg">Add to Home Screen</span>.
        </p>
        {#if !secure}
          <p class="mt-1 text-xs text-fg-faint">
            Note: this address is not HTTPS — notifications need a secure context even after installing.
          </p>
        {/if}
        <p class="mt-1 text-xs text-fg-faint">
          On iPhone, notifications only work from the installed Home Screen app — not from a browser tab (this
          includes Firefox and Chrome on iOS, which use Apple's web engine).
        </p>
      {:else}
        <p class="mt-1 text-fg-muted">Add TornScope to your device for an app-like experience and faster access.</p>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-2">
      {#if deferredPrompt && !showIOSHint}
        <button class="btn btn-sm" onclick={() => void nativeInstall()} disabled={installing}>
          {installing ? "Installing…" : "Install"}
        </button>
      {/if}
      <button class="btn btn-sm !px-2.5" onclick={dismiss} aria-label="Dismiss install hint">✕</button>
    </div>
  </div>
{/if}
