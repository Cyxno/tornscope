<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * Soft layered panel: rounded, hairline border, ambient shadow.
   * `flush` renders children without inner padding (charts handle their own).
   */
  let { title, caption, actions, children, flush = false }: { title?: string; caption?: string; actions?: Snippet; children?: Snippet; flush?: boolean } = $props();
</script>

<section class="rounded-2xl border border-border bg-surface shadow-panel">
  {#if title || actions}
    <div class="flex items-start justify-between gap-4 px-6 pt-5 {flush ? 'pb-0' : 'pb-1'}">
      <div>
        {#if title}<h2 class="text-[14px] font-semibold tracking-tight text-fg">{title}</h2>{/if}
        {#if caption}<p class="mt-0.5 text-xs leading-relaxed text-fg-muted">{caption}</p>{/if}
      </div>
      {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
    </div>
  {/if}
  <div class="{flush ? 'px-2 pb-2 pt-3' : 'px-6 pb-6 pt-4'}">
    {@render children?.()}
  </div>
</section>
