<script lang="ts">
  import { page } from "$app/state";
  import { browser } from "$app/environment";
  import { env as publicEnv } from "$env/dynamic/public";
  import { me } from "$lib/state.svelte";
  import { NAV_SECTIONS, familyForPath, isActivePath, type NavFamily, type NavItem } from "$lib/nav";
  import Icon from "./Icon.svelte";
  import { build, loadBuildIdentity } from "$lib/build.svelte";

  loadBuildIdentity();

  /**
   * Desktop navigation rail (Option B shell). The nav leaves the top bar
   * entirely: a slim, always-visible rail anchors every desktop page —
   * labeled from xl up, icon-only between lg and xl. Below lg the compact
   * top bar + bottom tab bar take over (Header / MobileNav).
   *
   * IA (2.5.2): progressive disclosure. Primary destinations are always
   * visible; secondary pages live inside collapsible families (max two
   * levels: family → route). The family containing the current page always
   * expands, so an active child is never hidden inside a collapsed group;
   * other collapse choices persist browser-locally. No network state.
   *
   * Environment chip: production shows "Production"; dev/staging
   * shows its PUBLIC_ENV_LABEL so staging can never pose as the beta.
   */
  const envLabel = publicEnv.PUBLIC_ENV_LABEL?.trim() || "Production";

  const syncTone = $derived(
    me.data?.syncHealth.running ? "bg-accent live-dot" : me.data?.syncHealth.lastSuccessAt ? "bg-positive" : "bg-fg-faint"
  );
  const syncLabel = $derived(
    !me.loaded ? "…" : me.data?.syncHealth.running ? "Syncing" : me.data?.syncHealth.lastSuccessAt ? "Synced" : "Not synced"
  );

  // ---- Family collapse state (browser-local, no network) ----
  // Families start collapsed; the active family auto-expands. Manual choices
  // persist locally: an expanded family stays open across navigation and a
  // collapsed family stays closed — but arriving at a child page always
  // re-expands its family (navigation IS the intent to be in that family),
  // so the current route is never hidden inside a collapsed group.
  const COLLAPSE_KEY = "tornscope:nav-collapsed-families";
  interface CollapseState {
    collapsed: string[];
    expanded: string[];
  }

  function readCollapseState(): CollapseState {
    if (!browser) return { collapsed: [], expanded: [] };
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}");
      const obj = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      return { collapsed: ids(obj.collapsed), expanded: ids(obj.expanded) };
    } catch {
      return { collapsed: [], expanded: [] };
    }
  }

  let collapse = $state<CollapseState>(readCollapseState());

  function persistCollapse(next: CollapseState) {
    if (!browser) return;
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode etc.) — collapsing still works,
      // it just does not persist.
    }
  }

  const activeFamilyId = $derived(familyForPath(page.url.pathname)?.id ?? null);

  // When the active family changes, drop its sticky "collapsed" mark: landing
  // on one of its pages must surface that page. Collapsing again by hand
  // still works and keeps working while the user stays on the page.
  let lastActiveFamilyId: string | null = null;
  $effect(() => {
    const active = activeFamilyId;
    if (active && active !== lastActiveFamilyId && collapse.collapsed.includes(active)) {
      collapse = { ...collapse, collapsed: collapse.collapsed.filter((id) => id !== active) };
      persistCollapse(collapse);
    }
    lastActiveFamilyId = active;
  });

  /**
   * The active family expands on arrival (the effect above clears any stale
   * sticky-collapse when the family becomes active); while the user stays on
   * its pages a manual collapse is respected, and other families follow
   * purely manual choices.
   */
  function isExpanded(family: NavFamily): boolean {
    if (collapse.expanded.includes(family.id)) return true;
    if (family.id === activeFamilyId) return !collapse.collapsed.includes(family.id);
    return false;
  }

  function toggleFamily(family: NavFamily) {
    const expandedNow = isExpanded(family);
    const collapsed = collapse.collapsed.filter((id) => id !== family.id);
    const expanded = collapse.expanded.filter((id) => id !== family.id);
    if (expandedNow) {
      collapsed.push(family.id);
    } else {
      expanded.push(family.id);
    }
    collapse = { collapsed, expanded };
    persistCollapse(collapse);
  }

  function familyLabel(family: NavFamily): string {
    return family.parent?.label ?? family.header?.label ?? family.id;
  }

  /** System pages live in the rail footer (always visible), not the list. */
  const systemSection = $derived(NAV_SECTIONS.find((s) => s.id === "system"));
</script>

{#snippet navRow(item: NavItem, opts?: { child?: boolean })}
  {@const active = isActivePath(page.url.pathname, item.href)}
  <a
    href={item.href}
    title={item.label}
    class="relative flex min-h-[34px] items-center gap-3 rounded-[10px] px-3 text-[13.5px] font-medium transition-colors {active
      ? 'bg-surface-2 text-fg'
      : 'text-fg-muted hover:bg-surface hover:text-fg'} {opts?.child ? 'mt-0.5 pl-7' : ''}"
    aria-current={active ? "page" : undefined}
  >
    {#if active}
      <span class="absolute -left-3 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent xl:-left-3" aria-hidden="true"></span>
    {/if}
    <Icon name={item.icon} size={18} class="shrink-0 {active ? 'text-accent' : ''}" />
    <span class="hidden truncate xl:block">{item.label}</span>
  </a>
{/snippet}

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
        title={`${envLabel} environment`}
      >{envLabel}</span>
    </span>
  </a>

  <!-- Build identity renders in the rail footer so it never pushes the
       navigation list down; a deployment is never anonymous on-screen. -->

  <!-- Grouped navigation: primary rows + collapsible secondary families.
       System pages render in the footer below, so the scrollable list stays
       short enough for ordinary laptop screens. -->
  <nav class="flex-1 overflow-y-auto py-3" aria-label="Primary">
    {#each NAV_SECTIONS as section (section.id)}
      {#if section.id !== "system"}
        <!-- The Core rows speak for themselves; every other section keeps its label. -->
        {#if section.id !== "core"}
          <p class="section-label mb-1 hidden px-5 xl:block">{section.label}</p>
        {/if}
        <div class="mb-2 space-y-0.5 px-2.5 xl:px-3">
          {#each section.entries as item (item.href)}
            {@render navRow(item)}
          {/each}
          {#each section.families as family (family.id)}
          {@const expanded = isExpanded(family)}
          {@const childActive = family.children.some((c) => isActivePath(page.url.pathname, c.href))}
          {@const parentActive = family.parent ? isActivePath(page.url.pathname, family.parent.href) : false}
          <div>
            <div class="flex items-center">
              {#if family.parent}
                <!-- Hub page: the label navigates, only the chevron toggles. -->
                <a
                  href={family.parent.href}
                  title={family.parent.label}
                  class="relative flex min-h-[34px] min-w-0 flex-1 items-center gap-3 rounded-l-[10px] px-3 text-[13.5px] font-medium transition-colors {(parentActive || childActive)
                    ? 'text-fg'
                    : 'text-fg-muted hover:bg-surface hover:text-fg'}"
                  aria-current={parentActive ? "page" : undefined}
                >
                  {#if parentActive}
                    <span class="absolute -left-3 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent" aria-hidden="true"></span>
                  {/if}
                  <Icon name={family.parent.icon} size={18} class="shrink-0 {(parentActive || childActive) ? 'text-accent' : ''}" />
                  <span class="hidden truncate xl:block">{family.parent.label}</span>
                </a>
              {:else if family.header}
                <span
                  class="flex min-h-[34px] min-w-0 flex-1 items-center gap-3 px-3 text-[13.5px] font-medium text-fg-muted"
                  title={family.header.label}
                >
                  <Icon name={family.header.icon} size={18} class="shrink-0 {childActive ? 'text-accent' : ''}" />
                  <span class="hidden truncate xl:block">{family.header.label}</span>
                </span>
              {/if}
              <button
                type="button"
                class="flex h-[34px] w-7 shrink-0 items-center justify-center rounded-r-[10px] text-fg-faint transition-colors hover:text-fg"
                aria-expanded={expanded}
                aria-controls={"nav-family-" + family.id}
                aria-label={(expanded ? "Collapse " : "Expand ") + familyLabel(family)}
                title={(expanded ? "Collapse " : "Expand ") + familyLabel(family)}
                onclick={() => toggleFamily(family)}
              >
                <Icon
                  name="chevron-down"
                  size={14}
                  class="transition-transform duration-150 {expanded ? '' : '-rotate-90'} {(parentActive || childActive) ? 'text-accent' : ''}"
                />
              </button>
            </div>
            {#if expanded}
              <div id={"nav-family-" + family.id} class="mt-0.5 space-y-0.5">
                {#each family.children as child (child.href)}
                  {@render navRow(child, { child: true })}
                {/each}
              </div>
            {/if}
          </div>
          {/each}
        </div>
      {/if}
    {/each}
  </nav>

  <!-- Bottom: sync health + identity (persistent affordances, not list rows) -->
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

    <!-- System utilities: always visible, never inside the scrollable list. -->
    <div class="flex items-center justify-between gap-2 px-3 pt-1">
      {#each systemSection?.entries ?? [] as item (item.href)}
        {@const active = isActivePath(page.url.pathname, item.href)}
        <a
          href={item.href}
          title={item.label}
          class="flex min-h-[26px] items-center gap-1.5 text-[10.5px] font-medium tracking-wide transition-colors {active
            ? 'text-accent'
            : 'text-fg-faint hover:text-fg-muted'}"
          aria-current={active ? "page" : undefined}
        >
          <Icon name={item.icon} size={12} class="shrink-0" />
          <span class="hidden truncate xl:block">{item.label}</span>
        </a>
      {/each}
    </div>

    <!-- Deployed build identity -->
    {#if build.text}
      <p class="hidden px-3 pt-1.5 text-[9.5px] font-medium tracking-wide text-fg-faint xl:block" title="Deployed build">{build.text}</p>
    {/if}
  </div>
</aside>
