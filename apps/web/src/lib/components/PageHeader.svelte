<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The one page-header pattern: quiet eyebrow, serif display title,
   * concise description, actions (date controls / primary action) aligned
   * right. Every major page mounts this — no page invents its own header.
   */
  let { eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: Snippet } = $props();
</script>

<header class="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
  <div class="max-w-2xl space-y-2">
    {#if eyebrow}
      <p class="section-label flex items-center gap-2">
        <span class="h-1 w-1 rounded-full bg-accent/70" aria-hidden="true"></span>
        {eyebrow}
      </p>
    {/if}
    <h1 class="font-display text-[28px] font-medium leading-tight text-fg sm:text-[32px]">{title}</h1>
    {#if description}
      <p class="text-[13px] leading-relaxed text-fg-muted">{description}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex flex-wrap items-center gap-3">{@render actions()}</div>
  {/if}
</header>
