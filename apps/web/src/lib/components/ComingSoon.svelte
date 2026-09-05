<script lang="ts">
  let { title, description }: { title: string; description: string } = $props();
</script>

<div class="space-y-8">
  <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-fg-faint">{title}</p>
  <div class="flex max-w-xl flex-col items-start gap-4">
    <h2 class="font-display text-3xl font-medium leading-snug text-fg">On the roadmap.</h2>
    <p class="text-sm leading-relaxed text-fg-muted">{description}</p>
    <p class="text-[13px] leading-relaxed text-fg-faint">
      The database schema and sync foundation for this module already exist. It lights up automatically once the
      corresponding sync jobs land — no placeholder analytics, ever.
    </p>
  </div>
</div>
