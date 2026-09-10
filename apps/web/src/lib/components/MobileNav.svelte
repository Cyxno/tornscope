<script lang="ts">
  import { page } from "$app/state";
  import { me } from "$lib/state.svelte";
  import { NAV_GROUPS, MOBILE_TABS, isActivePath } from "$lib/nav";
  import Icon from "./Icon.svelte";

  /**
   * Mobile navigation: fixed bottom tab bar (three primary destinations +
   * More) and a grouped sheet behind it. The bar is thumb-reachable and
   * always visible; the sheet carries every route so nothing is hidden.
   */

  let sheetOpen = $state(false);

  const moreActive = $derived(
    NAV_GROUPS.filter((g) => g.id !== "core").some((g) => g.items.some((i) => isActivePath(page.url.pathname, i.href))) &&
      !MOBILE_TABS.some((t) => isActivePath(page.url.pathname, t.href) && t.href !== "/timeline")
  );

  function openSheet() {
    sheetOpen = true;
  }
  function closeSheet() {
    sheetOpen = false;
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
      {@const active = isActivePath(page.url.pathname, tab.href)}
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

<!-- Grouped nav sheet -->
{#if sheetOpen}
  <div class="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="All sections">
    <button type="button" class="absolute inset-0 bg-black/60" aria-label="Close navigation" onclick={closeSheet}></button>
    <div class="absolute inset-x-0 bottom-0 rise-in rounded-t-2xl border-t border-border bg-bg-raise pb-[calc(env(safe-area-inset-bottom)+72px)] shadow-pop">
      <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
        <p class="text-[13px] font-semibold text-fg">All sections</p>
        <button type="button" class="btn btn-sm" onclick={closeSheet}>
          <Icon name="close" size={13} /> Close
        </button>
      </div>
      <div class="max-h-[60vh] overflow-y-auto px-5 py-4">
        {#each NAV_GROUPS as group (group.id)}
          <p class="section-label mb-2">{group.label}</p>
          <div class="mb-5 grid grid-cols-2 gap-2">
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
        {/each}
        {#if me.data?.isDemo}
          <p class="chip chip-warning mx-auto mt-1">Demo mode — synthetic data</p>
        {/if}
      </div>
    </div>
  </div>
{/if}
