<script lang="ts">
  import { page } from "$app/state";
  import { env as publicEnv } from "$env/dynamic/public";
  import { me } from "$lib/state.svelte";

  // Environment chip label. Unset (production) shows "Beta"; non-production
  // deployments set PUBLIC_ENV_LABEL (e.g. "Development") so a staging
  // instance can never be mistaken for the public beta.
  const envLabel = publicEnv.PUBLIC_ENV_LABEL?.trim() || "Beta";

  const nav = [
    { href: "/", label: "Overview" },
    { href: "/today", label: "Today" },
    { href: "/drugs", label: "Drugs" },
    { href: "/money", label: "Economy" },
    { href: "/travel", label: "Travel" },
    { href: "/crimes", label: "Crimes" },
    { href: "/combat", label: "Combat" },
    { href: "/faction", label: "Faction" },
    { href: "/timeline", label: "Timeline" },
  ];

  function isActive(href: string): boolean {
    if (href === "/") return page.url.pathname === "/";
    return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  }

  const syncLabel = $derived(
    !me.loaded ? "…" : me.data?.syncHealth.running ? "Syncing" : me.data?.syncHealth.lastSuccessAt ? "Synced" : "Not synced"
  );
</script>

<header class="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md">
  <div class="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5">
    <!-- Brand: scope/radar mark + wordmark text (the full wide logo would
         compress navigation; the mark preserves the supplied identity) -->
    <a href="/" class="group flex items-center gap-2.5" title="TornScope">
      <img
        src="/icons/tornscope-96.png"
        alt=""
        aria-hidden="true"
        class="h-8 w-8 rounded-lg transition-transform group-hover:scale-105"
      />
      <span class="text-[15px] font-semibold tracking-tight text-fg">TornScope</span>
      <!-- Environment chip: subtle, in the design system's chip language.
           Production shows "Beta" (the release status should never read as
           stable/GA); dev/staging shows its PUBLIC_ENV_LABEL instead. -->
      <span
        class="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-accent"
        title={envLabel === "Beta" ? "TornScope is in public beta" : "Development environment — not the public beta"}
      >{envLabel}</span>
    </a>

    <!-- Primary navigation: horizontal, pill segmented -->
    <nav class="hidden items-center gap-1 lg:flex" aria-label="Primary">
      {#each nav as item (item.href)}
        <a
          href={item.href}
          class="rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors {isActive(item.href)
            ? 'bg-surface-2 text-fg'
            : 'text-fg-muted hover:text-fg'}"
          aria-current={isActive(item.href) ? "page" : undefined}
        >
          {item.label}
        </a>
      {/each}
    </nav>

    <!-- Right cluster: sync pulse + identity -->
    <div class="flex items-center gap-2">
      <a
        href="/sync"
        class="hidden items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg sm:flex"
        title="Sync status"
      >
        <span class="h-1.5 w-1.5 rounded-full {me.data?.syncHealth.running ? 'live-dot bg-accent' : me.data?.syncHealth.lastSuccessAt ? 'bg-positive' : 'bg-fg-faint'}"></span>
        {syncLabel}
      </a>
      <a
        href="/settings"
        class="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 text-xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
        title="Settings"
      >
        {#if me.data?.torn}
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-fg">{me.data.torn.name.slice(0, 2).toUpperCase()}</span>
          <span class="tnum hidden sm:inline">{me.data.torn.name}</span>
        {:else}
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[11px]">⚙</span>
          <span class="hidden sm:inline">Settings</span>
        {/if}
      </a>
    </div>
  </div>

  <!-- Mobile nav: horizontal scroll -->
  <nav class="flex gap-1 overflow-x-auto px-4 pb-2.5 lg:hidden" aria-label="Primary mobile">
    {#each nav as item (item.href)}
      <a
        href={item.href}
        class="whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors {isActive(item.href) ? 'bg-surface-2 text-fg' : 'text-fg-muted'}"
        aria-current={isActive(item.href) ? "page" : undefined}
      >
        {item.label}
      </a>
    {/each}
  </nav>
</header>
