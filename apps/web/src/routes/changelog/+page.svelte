<script lang="ts">
  import { CHANGELOG, changelogReleases, entriesByKind } from "$lib/changelog";
  import PageHeader from "$lib/components/PageHeader.svelte";

  /**
   * Changelog — the release history, rendered from the single structured
   * source (lib/changelog.ts). Latest release first; compact categorized
   * lists under each release header. No data fetching: pure presentation.
   */

  const releases = changelogReleases();

  /** Kind accent — quiet labels, one hue per category, no per-card boxes. */
  const KIND_LABELS: Record<string, string> = {
    Added: "Added",
    Improved: "Improved",
    Fixed: "Fixed",
    Technical: "Technical",
  };
  const KIND_CLASS: Record<string, string> = {
    Added: "text-positive",
    Improved: "text-accent",
    Fixed: "text-warning",
    Technical: "text-fg-faint",
  };
</script>

<svelte:head><title>Changelog · TornScope</title></svelte:head>

<div class="space-y-10">
  <PageHeader
    eyebrow="Release history"
    title="Changelog"
    description="What shipped, when, and why it matters — newest first, from the real release history of this instance."
  />

  <div class="space-y-12">
    {#each releases as release (release.version)}
      {@const groups = entriesByKind(release)}
      <section aria-label={`Release ${release.version}`} class="scroll-mt-24">
        <!-- Release header: version — the current deployment marked -->
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border pb-3">
          <h2 class="font-display text-[22px] font-medium leading-tight text-fg">
            {release.version}
            {#if release.current}
              <span class="ml-1 inline-flex h-2 w-2 translate-y-[-2px] rounded-full bg-accent" title="This deployment runs this release" aria-label="current release"></span>
            {/if}
          </h2>
        </div>

        {#if release.summary}
          <p class="mt-3 max-w-3xl text-[13px] leading-relaxed text-fg-muted">{release.summary}</p>
        {/if}

        <!-- Compact categorized changes — no wall-of-text cards -->
        <div class="mt-4 grid gap-x-10 gap-y-4 md:grid-cols-2">
          {#each groups as group (group.kind)}
            <div class="min-w-0">
              <p class="section-label text-[10.5px] {KIND_CLASS[group.kind]}">{KIND_LABELS[group.kind]}</p>
              <ul class="mt-1.5 space-y-1.5">
                {#each group.entries as entry (entry)}
                  <li class="flex min-w-0 gap-2 text-[12.5px] leading-relaxed text-fg-muted">
                    <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-border-strong" aria-hidden="true"></span>
                    <span class="min-w-0">{entry}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</div>
