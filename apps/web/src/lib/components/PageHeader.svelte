<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * Editorial page header: small-caps eyebrow, serif display title,
   * optional description, actions on the right.
   */
  let { eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: Snippet } = $props();
</script>

<header class="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
  <div class="max-w-2xl space-y-2.5">
    {#if eyebrow}
      <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-faint">{eyebrow}</p>
    {/if}
    <h1 class="font-display text-4xl font-medium leading-tight text-fg">{title}</h1>
    {#if description}
      <p class="text-sm leading-relaxed text-fg-muted">{description}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex items-center gap-3">{@render actions()}</div>
  {/if}
</header>
