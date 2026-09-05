<script lang="ts">
  let { level }: { level: "exact" | "derived" | "estimated" } = $props();

  const dot: Record<string, string> = {
    exact: "bg-fg-faint",
    derived: "bg-accent",
    estimated: "bg-warning",
  };
  const titles: Record<string, string> = {
    exact: "Exact value provided by the Torn API",
    derived: "Derived from exact Torn data",
    estimated: "Estimated value — not an exact Torn figure",
  };
</script>

<span class="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] text-fg-faint" title={titles[level]}>
  <span class="h-1.5 w-1.5 rounded-full {dot[level]}"></span>
  {level}
</span>
