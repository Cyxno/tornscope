<script lang="ts">
  /**
   * Compact lens switcher — the segmented-control idiom from
   * SegmentedDateRange, with proper tablist semantics and arrow-key roving
   * focus. Used below the lg breakpoint where only one Economy lens renders
   * at a time; on desktop every lens is visible and the switcher is hidden.
   */
  let {
    tabs,
    active,
    onselect,
  }: {
    tabs: Array<{ id: string; label: string }>;
    active: string;
    onselect: (id: string) => void;
  } = $props();

  function focusTab(id: string) {
    queueMicrotask(() => (document.getElementById(`lens-tab-${id}`) as HTMLElement | null)?.focus());
  }

  function onKeydown(event: KeyboardEvent, current: string) {
    const idx = tabs.findIndex((t) => t.id === current);
    if (idx === -1) return;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (idx + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (idx - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    onselect(tabs[next]!.id);
    focusTab(tabs[next]!.id);
  }
</script>

<div class="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-full border border-border bg-surface p-1" role="tablist" aria-label="Economy lenses">
  {#each tabs as tab (tab.id)}
    <button
      role="tab"
      id="lens-tab-{tab.id}"
      aria-selected={active === tab.id}
      aria-controls="lens-panel-{tab.id}"
      tabindex={active === tab.id ? 0 : -1}
      class="rounded-full px-3 py-1.5 text-xs font-medium transition-all {active === tab.id
        ? 'bg-fg font-semibold text-bg'
        : 'text-fg-muted hover:text-fg'}"
      onclick={() => onselect(tab.id)}
      onkeydown={(e) => onKeydown(e, tab.id)}
    >
      {tab.label}
    </button>
  {/each}
</div>
