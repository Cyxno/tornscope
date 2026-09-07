<script lang="ts">
  import { page } from "$app/state";
</script>

<svelte:head><title>Error · TornScope</title></svelte:head>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
  <p class="font-display text-7xl font-medium text-accent">{page.status}</p>
  <p class="max-w-md text-sm leading-relaxed text-fg-muted">
    {page.error?.message ?? "An unexpected error occurred"}
  </p>
  <a href="/" class="mt-2 rounded-full border border-border-strong px-5 py-2 text-xs font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent">
    Back to the dashboard
  </a>
</div>
