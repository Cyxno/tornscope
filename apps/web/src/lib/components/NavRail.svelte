<script lang="ts">
  import { page } from "$app/state";
  import { env as publicEnv } from "$env/dynamic/public";
  import { me } from "$lib/state.svelte";
  import { NAV_GROUPS, isActivePath } from "$lib/nav";
  import Icon from "./Icon.svelte";
  import { build, loadBuildIdentity } from "$lib/build.svelte";

  loadBuildIdentity();

  /**
   * Desktop navigation rail (Option B shell). The nav leaves the top bar
   * entirely: a slim, always-visible rail anchors every desktop page —
   * labeled from xl up, icon-only between lg and xl. Below lg the compact
   * top bar + bottom tab bar take over (Header / MobileNav).
   *
   * Environment chip: production shows "Public Testing"; dev/staging
   * shows its PUBLIC_ENV_LABEL so staging can never pose as the beta.
   */
  const envLabel = publicEnv.PUBLIC_ENV_LABEL?.trim() || "Public Testing";

  const syncTone = $derived(
    me.data?.syncHealth.running ? "bg-accent live-dot" : me.data?.syncHealth.lastSuccessAt ? "bg-positive" : "bg-fg-faint"
  );
  const syncLabel = $derived(
    !me.loaded ? "…" : me.data?.syncHealth.running ? "Syncing" : me.data?.syncHealth.lastSuccessAt ? "Synced" : "Not synced"
  );
</script>

<!-- Safe-area top inset: in an installed standalone web app on notched
     devices the rail starts under the status bar; 0 in normal browsers. -->
<aside
  class="sticky top-0 z-40 hidden h-screen w-[68px] shrink-0 flex-col border-r border-border bg-bg-raise lg:flex xl:w-[228px]"
  style="padding-top: env(safe-area-inset-top);"
>
  <!-- Brand -->
  <a href="/" class="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-4 xl:px-5" title="TornScope" aria-label="TornScope — Overview">
    <img src="/icons/tornscope-96.png" alt="" aria-hidden="true" class="h-7 w-7 rounded-lg" />
    <span class="hidden min-w-0 xl:block">
      <span class="block text-[14.5px] font-semibold leading-tight tracking-tight text-fg">TornScope</span>
      <span
        class="mt-0.5 inline-block rounded-full border border-accent/30 bg-accent/10 px-1.5 text-[8.5px] font-semibold uppercase leading-[1.4] tracking-[0.14em] text-accent"
        title={envLabel === "Public Testing" ? "TornScope 1.0.0 — public testing" : "Development environment — not the public testing site"}
      >{envLabel}</span>
    </span>
  </a>

  <!-- Build identity: never let a deployment be anonymous on-screen. -->
  {#if build.text}
    <p class="hidden px-5 pb-2 text-[9.5px] font-medium tracking-wide text-fg-faint xl:block" title="Deployed build">{build.text}</p>
  {/if}

  <!-- Grouped navigation -->
  <nav class="flex-1 overflow-y-auto py-4" aria-label="Primary">
    {#each NAV_GROUPS as group (group.id)}
      <p class="section-label mb-1.5 hidden px-5 xl:block">{group.label}</p>
      <div class="mb-3 space-y-0.5 px-2.5 xl:px-3">
        {#each group.items as item (item.href)}
          {@const active = isActivePath(page.url.pathname, item.href)}
          <a
            href={item.href}
            title={item.label}
            class="relative flex min-h-[38px] items-center gap-3 rounded-[10px] px-3 text-[13.5px] font-medium transition-colors {active
              ? 'bg-surface-2 text-fg'
              : 'text-fg-muted hover:bg-surface hover:text-fg'}"
            aria-current={active ? "page" : undefined}
          >
            {#if active}
              <span class="absolute -left-3 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent xl:-left-3" aria-hidden="true"></span>
            {/if}
            <Icon name={item.icon} size={18} class="shrink-0 {active ? 'text-accent' : ''}" />
            <span class="hidden truncate xl:block">{item.label}</span>
          </a>
        {/each}
      </div>
    {/each}
  </nav>

  <!-- Bottom: sync health + identity -->
  <div class="shrink-0 space-y-0.5 border-t border-border px-2.5 py-3 xl:px-3">
    <a
      href="/sync"
      title="Sync status — {syncLabel}"
      class="flex min-h-[40px] items-center gap-3 rounded-[10px] px-3 text-[12.5px] font-medium transition-colors text-fg-muted hover:bg-surface hover:text-fg"
    >
      <span class="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <span class="h-1.5 w-1.5 rounded-full {syncTone}"></span>
      </span>
      <span class="hidden min-w-0 xl:block">
        <span class="block leading-tight">{syncLabel}</span>
        <span class="block text-[10.5px] font-normal leading-tight text-fg-faint">Sync status</span>
      </span>
    </a>
    <a
      href="/settings"
      title="Settings"
      class="flex min-h-[40px] items-center gap-3 rounded-[10px] px-3 text-[12.5px] font-medium transition-colors text-fg-muted hover:bg-surface hover:text-fg"
    >
      {#if me.data?.torn}
        <span class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[8px] font-semibold text-fg">{me.data.torn.name.slice(0, 2).toUpperCase()}</span>
        <span class="hidden min-w-0 xl:block">
          <span class="block truncate leading-tight text-fg">{me.data.torn.name}</span>
          <span class="block text-[10.5px] font-normal leading-tight text-fg-faint">Settings</span>
        </span>
      {:else}
        <span class="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-2"><Icon name="settings" size={11} /></span>
        <span class="hidden xl:block">Settings</span>
      {/if}
    </a>
  </div>
</aside>
