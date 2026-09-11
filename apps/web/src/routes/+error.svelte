<script lang="ts">
  import { page } from "$app/state";
</script>

<svelte:head><title>Error · TornScope</title></svelte:head>

<div class="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
  <p class="font-display text-7xl font-medium text-accent">{page.status}</p>
  <p class="max-w-md text-sm leading-relaxed text-fg-muted">
    {page.error?.message ?? "An unexpected error occurred"}
  </p>
  <a href="/" class="btn mt-2">
    Back to Overview
  </a>
</div>
