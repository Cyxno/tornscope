<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * The one panel primitive. Variants (deliberately few):
   * - "surface": standard card (default)
   * - "outlined": transparent with hairline — secondary/grouped content
   * - "quiet": no box at all — content that groups by spacing alone
   * `flush` renders children edge-to-edge (charts handle their own padding).
   */
  let {
    title,
    caption,
    actions,
    children,
    footer,
    variant = "surface",
    flush = false,
    bodyClass = "",
    class: cls = "",
  }: {
    title?: string;
    caption?: string;
    actions?: Snippet;
    children?: Snippet;
    footer?: Snippet;
    variant?: "surface" | "outlined" | "quiet";
    flush?: boolean;
    bodyClass?: string;
    /** Extra classes on the shell (e.g. h-full for equal-height grid rows). */
    class?: string;
  } = $props();

  const shell = {
    surface: "rounded-card border border-border bg-surface shadow-panel",
    outlined: "rounded-card border border-border bg-transparent",
    quiet: "",
  };
</script>

<section class="{shell[variant]} min-w-0 {cls}">
  {#if title || actions}
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 {flush ? 'px-5 pt-4 sm:px-6' : 'px-5 pt-4 sm:px-6'}">
      <div class="min-w-0">
        {#if title}<h2 class="text-[13px] font-semibold tracking-tight text-fg">{title}</h2>{/if}
        {#if caption}<p class="mt-0.5 max-w-2xl text-xs leading-relaxed text-fg-muted">{caption}</p>{/if}
      </div>
      {#if actions}<div class="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">{@render actions()}</div>{/if}
    </div>
  {/if}
  <div class="{flush ? 'px-2 pb-2 pt-3 sm:px-3' : 'px-5 pb-5 pt-4 sm:px-6'} {bodyClass}">
    {@render children?.()}
  </div>
  {#if footer}
    <div class="border-t border-border px-5 py-3 sm:px-6">
      {@render footer()}
    </div>
  {/if}
</section>
