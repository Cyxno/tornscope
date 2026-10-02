<script lang="ts">
  import { env as publicEnv } from "$env/dynamic/public";
  import { me } from "$lib/state.svelte";
  import Icon from "./Icon.svelte";

  /**
   * Context bar for BELOW-desktop widths (hidden at lg+ where the NavRail
   * owns navigation). Carries brand, the environment chip, sync pulse and
   * identity — never primary nav (the bottom tab bar + sheet do that).
   *
   * Environment chip: production shows "Production" (the release status should
   * never read as stable/GA); dev/staging shows its PUBLIC_ENV_LABEL so a
   * staging instance can never pose as the production release.
   */
  const envLabel = publicEnv.PUBLIC_ENV_LABEL?.trim() || "Production";

  const syncLabel = $derived(
    !me.loaded ? "…" : me.data?.syncHealth.running ? "Syncing" : me.data?.syncHealth.lastSuccessAt ? "Synced" : "Not synced"
  );
  const syncTone = $derived(
    me.data?.syncHealth.running ? "bg-accent live-dot" : me.data?.syncHealth.lastSuccessAt ? "bg-positive" : "bg-fg-faint"
  );
</script>

<!-- In the installed Home Screen app (black-translucent status bar) the page
     extends under the iOS status bar: pad the top by the safe-area inset.
     In normal browsers the inset is 0, so this is a no-op there. -->
<header
  class="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md lg:hidden"
  style="padding-top: env(safe-area-inset-top);"
>
  <div class="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
    <!-- Brand -->
    <a href="/" class="group flex min-w-0 items-center gap-2.5" title="TornScope">
      <img
        src="/icons/tornscope-96.png"
        alt=""
        aria-hidden="true"
        class="h-7 w-7 rounded-lg transition-transform group-hover:scale-105"
      />
      <span class="text-[14px] font-semibold tracking-tight text-fg">TornScope</span>
      <span
        class="hidden rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-accent sm:inline-block"
        title={`${envLabel} environment`}
      >{envLabel}</span>
    </a>

    <!-- Right cluster: sync + identity (nav lives in the bottom bar) -->
    <div class="flex shrink-0 items-center gap-2">
      <a
        href="/sync"
        class="flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
        title="Sync status"
      >
        <span class="h-1.5 w-1.5 rounded-full {syncTone}"></span>
        <span class="hidden min-[420px]:inline">{syncLabel}</span>
      </a>
      <a
        href="/settings"
        class="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-2.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
        title="Settings"
        aria-label="Settings"
      >
        {#if me.data?.torn}
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-fg">{me.data.torn.name.slice(0, 2).toUpperCase()}</span>
          <span class="tnum hidden min-[480px]:inline">{me.data.torn.name}</span>
        {:else}
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2"><Icon name="settings" size={12} /></span>
        {/if}
      </a>
    </div>
  </div>
</header>
