<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";

  /**
   * Rewards & games hub (2.5.3) — the navigating parent of the Casino,
   * Rewards and Hunting pages. A light wayfinding page, not an analytics
   * surface: it routes into the three cluster pages without duplicating
   * any of their data (no API calls by design).
   */
  const destinations = [
    {
      href: "/casino",
      icon: "slots",
      title: "Casino",
      description: "Your logged casino play — exact cash wagers and returns per game, with best and worst sessions. Descriptive history only.",
    },
    {
      href: "/rewards",
      icon: "cache",
      title: "Openables & rewards",
      description: "Supply packs, caches, wallets and similar openings — what went in, what came out, valued at market prices where the catalog allows.",
    },
    {
      href: "/hunting",
      icon: "hunting",
      title: "Hunting",
      description: "Logged hunting sessions — exact bait costs and prey-sale income, with the hunting-skill trajectory they record.",
    },
  ] as const;
</script>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Analytics"
    title="Rewards & games"
    description="The side-income cluster: what you won at the tables, opened from caches, and earned in the fields. Each page is its own retrospective — this hub just points the way."
  />

  <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
    {#each destinations as d (d.href)}
      <a
        href={d.href}
        class="group flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent/40"
      >
        <span class="flex items-center gap-2.5">
          <Icon name={d.icon} size={18} class="text-accent" />
          <span class="text-[14px] font-semibold text-fg">{d.title}</span>
          <Icon
            name="chevron-down"
            size={14}
            class="ml-auto -rotate-90 text-fg-faint transition-transform duration-150 group-hover:translate-x-0.5"
          />
        </span>
        <span class="text-[12.5px] leading-relaxed text-fg-muted">{d.description}</span>
      </a>
    {/each}
  </div>
</div>
