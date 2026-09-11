<script lang="ts">
  let { title, description }: { title: string; description: string } = $props();
</script>

<div class="space-y-8">
  <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-faint">{title}</p>
  <div class="flex max-w-xl flex-col items-start gap-4">
    <h2 class="font-display text-3xl font-medium leading-snug text-fg">On the roadmap.</h2>
    <p class="text-sm leading-relaxed text-fg-muted">{description}</p>
    <p class="text-[13px] leading-relaxed text-fg-faint">
      Data collection for this module already runs in the background — analytics switch on automatically as
      history accumulates.
    </p>
  </div>
</div>
