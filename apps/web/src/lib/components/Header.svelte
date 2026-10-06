<script lang="ts">
  import { page } from "$app/state";
  import { env as publicEnv } from "$env/dynamic/public";
  import { me } from "$lib/state.svelte";
  import { activeItemForPath } from "$lib/nav";
  import Icon from "./Icon.svelte";

  /**
   * Context bar for BELOW-desktop widths (hidden at lg+ where the NavRail
   * owns navigation). Carries brand, the environment chip, the current-page
   * context (most mobile routes are not bottom tabs — the header tells you
   * where you are without opening a menu), sync pulse and identity — never
   * primary nav (the bottom tab bar + sheet do that).
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

  // Current-page context: hidden on the Overview home (the brand says it
  // all) and on non-nav routes like /welcome. The full trail (family +
  // section) stays in the tooltip so the header never grows taller.
  const current = $derived(activeItemForPath(page.url.pathname));
  const currentLabel = $derived(current && current.item.href !== "/" ? current.item.label : null);
  const currentTrail = $derived(
    current && current.item.href !== "/"
      ? [current.family?.parent?.label ?? current.section?.label, current.item.label].filter(Boolean).join(" · ")
      : null
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
    <!-- Brand + current-page context -->
    <a href="/" class="group flex min-w-0 items-center gap-2.5" title={currentTrail ?? "TornScope"}>
      <img
        src="/icons/tornscope-96.png"
        alt=""
        aria-hidden="true"
        class="h-7 w-7 rounded-lg transition-transform group-hover:scale-105"
      />
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="text-[14px] font-semibold tracking-tight text-fg">TornScope</span>
        {#if currentLabel}
          <span class="min-w-0 truncate text-[13px] font-medium text-fg-muted" aria-current="page">· {currentLabel}</span>
        {/if}
      </span>
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
