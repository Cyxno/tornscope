<script lang="ts">
  import { page } from "$app/state";
  import { me } from "$lib/state.svelte";
  import { MOBILE_SHEET_GROUPS, MOBILE_TABS, familyForPath, isActivePath } from "$lib/nav";
  import Icon from "./Icon.svelte";

  /**
   * Mobile navigation: fixed bottom tab bar (the two core pages, the
   * Activity hub family, and More) plus a hierarchical sheet behind More.
   * The sheet is an accordion of semantic groups — max two open at a time —
   * instead of a wall of every route; the group containing the current page
   * starts expanded so deep-linked secondary pages land in context.
   */

  let sheetOpen = $state(false);
  /** Open accordion groups, most-recently-opened last (cap: two). */
  let openGroups = $state<string[]>([]);
  let sheetEl: HTMLElement | undefined = $state();

  const activeGroup = $derived(MOBILE_SHEET_GROUPS.find((g) => g.items.some((i) => isActivePath(page.url.pathname, i.href)))?.id ?? null);

  /** A tab also lights for its family: the Activity tab owns Timeline/Logs. */
  function tabActive(href: string): boolean {
    if (isActivePath(page.url.pathname, href)) return true;
    const family = familyForPath(page.url.pathname);
    return family?.parent?.href === href && family.children.some((c) => isActivePath(page.url.pathname, c.href));
  }

  const moreActive = $derived(activeGroup !== null && !MOBILE_TABS.some((t) => tabActive(t.href)));

  /** Svelte action: bring the active group's header into view once mounted. */
  function scrollActiveGroup(node: HTMLElement, active: boolean) {
    if (active) queueMicrotask(() => node.scrollIntoView({ block: "nearest" }));
  }

  function openSheet() {
    openGroups = activeGroup ? [activeGroup] : openGroups.slice(-1);
    sheetOpen = true;
    // Move keyboard focus into the dialog so Escape and Tab behave.
    queueMicrotask(() => sheetEl?.focus());
  }

  function closeSheet() {
    sheetOpen = false;
  }

  /** Max two groups open at once — opening a third closes the oldest. */
  function toggleGroup(id: string) {
    if (openGroups.includes(id)) {
      openGroups = openGroups.filter((g) => g !== id);
    } else {
      openGroups = [...openGroups, id].slice(-2);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") closeSheet();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Bottom tab bar -->
<nav
  class="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/92 backdrop-blur-md lg:hidden"
  style="padding-bottom: env(safe-area-inset-bottom);"
  aria-label="Primary mobile"
>
  <div class="grid grid-cols-4">
    {#each MOBILE_TABS as tab (tab.href)}
      {@const active = tabActive(tab.href)}
      <a
        href={tab.href}
        class="flex min-h-[56px] flex-col items-center justify-center gap-1 py-2 transition-colors {active ? 'text-accent' : 'text-fg-faint'}"
        aria-current={active ? "page" : undefined}
      >
        <Icon name={tab.icon} size={19} />
        <span class="text-[10px] font-medium leading-none">{tab.label}</span>
      </a>
    {/each}
    <button
      type="button"
      class="flex min-h-[56px] flex-col items-center justify-center gap-1 py-2 transition-colors {moreActive ? 'text-accent' : 'text-fg-faint'}"
      aria-expanded={sheetOpen}
      aria-haspopup="dialog"
      onclick={openSheet}
    >
      <Icon name="menu" size={19} />
      <span class="text-[10px] font-medium leading-none">More</span>
    </button>
  </div>
</nav>

<!-- Grouped accordion sheet -->
{#if sheetOpen}
  <div
    class="fixed inset-0 z-50 lg:hidden"
    role="dialog"
    aria-modal="true"
    aria-label="All sections"
    tabindex="-1"
    bind:this={sheetEl}
  >
    <button type="button" class="absolute inset-0 bg-black/60" aria-label="Close navigation" onclick={closeSheet}></button>
    <div class="absolute inset-x-0 bottom-0 rise-in rounded-t-2xl border-t border-border bg-bg-raise pb-[calc(env(safe-area-inset-bottom)+72px)] shadow-pop">
      <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
        <p class="text-[13px] font-semibold text-fg">All sections</p>
        <button type="button" class="btn btn-sm min-h-[44px]" onclick={closeSheet}>
          <Icon name="close" size={13} /> Close
        </button>
      </div>
      <div class="max-h-[62vh] overflow-y-auto px-4 py-3">
        {#each MOBILE_SHEET_GROUPS as group (group.id)}
          {@const expanded = openGroups.includes(group.id)}
          {@const groupActive = group.id === activeGroup}
          <div use:scrollActiveGroup={groupActive} class="mb-1.5">
            <button
              type="button"
              class="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 text-left transition-colors {groupActive
                ? 'bg-accent/10 text-accent'
                : 'text-fg-muted hover:bg-surface'}"
              aria-expanded={expanded}
              aria-controls={"nav-sheet-" + group.id}
              onclick={() => toggleGroup(group.id)}
            >
              <Icon name={group.icon} size={17} class="shrink-0 {groupActive ? 'text-accent' : ''}" />
              <span class="flex-1 text-[13.5px] font-semibold">{group.label}</span>
              <span class="tnum text-[10.5px] text-fg-faint">{group.items.length}</span>
              <Icon
                name="chevron-down"
                size={14}
                class="shrink-0 text-fg-faint transition-transform duration-150 {expanded ? '' : '-rotate-90'}"
              />
            </button>
            {#if expanded}
              <div id={"nav-sheet-" + group.id} class="mt-1 space-y-1">
                {#each group.items as item (item.href)}
                  {@const active = isActivePath(page.url.pathname, item.href)}
                  <a
                    href={item.href}
                    onclick={closeSheet}
                    class="flex min-h-[48px] items-center gap-3 rounded-xl border px-3.5 text-[13.5px] font-medium transition-colors {active
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-border bg-surface text-fg-muted'}"
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon name={item.icon} size={17} />
                    {item.label}
                  </a>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
        {#if me.data?.isDemo}
          <p class="chip chip-warning mx-auto mt-1">Demo mode — synthetic data</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
