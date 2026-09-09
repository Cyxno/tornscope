<script lang="ts">
  import { page } from "$app/state";
  import { env as publicEnv } from "$env/dynamic/public";
  import { me } from "$lib/state.svelte";
  import { NAV_GROUPS, isActivePath } from "$lib/nav";
  import Icon from "./Icon.svelte";

  /**
   * Desktop/tablet app bar. Mobile gets the dedicated tab bar + sheet
   * (MobileNav) — this header intentionally collapses to brand + live
   * status + identity below md instead of squeezing the full nav.
   */
  const envLabel = publicEnv.PUBLIC_ENV_LABEL?.trim() || "Beta";

  const syncLabel = $derived(
    !me.loaded ? "…" : me.data?.syncHealth.running ? "Syncing" : me.data?.syncHealth.lastSuccessAt ? "Synced" : "Not synced"
  );
  const syncTone = $derived(
    me.data?.syncHealth.running ? "bg-accent live-dot" : me.data?.syncHealth.lastSuccessAt ? "bg-positive" : "bg-fg-faint"
  );

  const primaryGroups = $derived(NAV_GROUPS.filter((g) => g.id !== "system"));
</script>

<header class="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
  <div class="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
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
        class="chip chip-accent hidden !text-[9px] !font-semibold uppercase tracking-[0.14em] sm:inline-flex"
        title={envLabel === "Beta" ? "TornScope is in public beta" : "Development environment — not the public beta"}
      >{envLabel}</span>
    </a>

    <!-- Primary navigation (lg+): grouped, hairline-separated -->
    <nav class="hidden min-w-0 items-center gap-0.5 lg:flex" aria-label="Primary">
      {#each primaryGroups as group, gi (group.id)}
        {#if gi > 0}<span class="mx-2.5 h-4 w-px bg-border" aria-hidden="true"></span>{/if}
        {#each group.items as item (item.href)}
          {@const active = isActivePath(page.url.pathname, item.href)}
          <a
            href={item.href}
            class="whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors {active
              ? 'bg-surface-2 text-fg'
              : 'text-fg-muted hover:text-fg'}"
            aria-current={active ? "page" : undefined}
          >
            {item.label}
          </a>
        {/each}
      {/each}
    </nav>

    <!-- Right cluster: sync + identity -->
    <div class="flex shrink-0 items-center gap-2">
      <a
        href="/sync"
        class="hidden items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg sm:flex"
        title="Sync status"
      >
        <span class="h-1.5 w-1.5 rounded-full {syncTone}"></span>
        {syncLabel}
      </a>
      <a
        href="/settings"
        class="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-2.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
        title="Settings"
        aria-label="Settings"
      >
        {#if me.data?.torn}
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-fg">{me.data.torn.name.slice(0, 2).toUpperCase()}</span>
          <span class="tnum hidden md:inline">{me.data.torn.name}</span>
        {:else}
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2"><Icon name="settings" size={12} /></span>
        {/if}
      </a>
    </div>
  </div>

  <!-- Tablet scroll row (md–lg): primary pages, quiet scroll affordance -->
  <nav class="flex gap-1 overflow-x-auto px-4 pb-2 lg:hidden md:flex [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Primary tablet">
    {#each NAV_GROUPS.filter((g) => g.id !== "system").flatMap((g) => g.items) as item (item.href)}
      {@const active = isActivePath(page.url.pathname, item.href)}
      <a
        href={item.href}
        class="whitespace-nowrap rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors {active
          ? 'bg-surface-2 text-fg'
          : 'text-fg-muted'}"
        aria-current={active ? "page" : undefined}
      >
        {item.label}
      </a>
    {/each}
  </nav>
</header>
