<script lang="ts">
  import { page } from "$app/state";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import AlertsInbox from "$lib/components/alerts/AlertsInbox.svelte";
  import AlertsRules from "$lib/components/alerts/AlertsRules.svelte";
  import AlertsChannels from "$lib/components/alerts/AlertsChannels.svelte";

  /**
   * Alerts (2.9.0): rules, Discord channels and the in-app inbox. Tabbed IA
   * with ?tab= deep links (same pattern as Settings); the inbox is the
   * default so the bell lands on the notifications themselves.
   */

  const TABS = [
    { id: "inbox", label: "Inbox" },
    { id: "rules", label: "Rules" },
    { id: "channels", label: "Discord channels" },
  ] as const;
  type TabId = (typeof TABS)[number]["id"];
  const TAB_IDS = TABS.map((t) => t.id);
  let activeTab = $state<TabId>("inbox");

  $effect(() => {
    // Initialize once from the URL; invalid values fall back to Inbox.
    const raw = new URLSearchParams(window.location.search).get("tab");
    if (raw && (TAB_IDS as string[]).includes(raw)) activeTab = raw as TabId;
  });

  // Keep the tab in sync with incoming navigations (e.g. a link with ?tab=).
  $effect(() => {
    const raw = page.url.searchParams.get("tab");
    if (raw && (TAB_IDS as string[]).includes(raw) && raw !== activeTab) activeTab = raw as TabId;
  });

  // Back/forward must keep the tab in sync with the URL: switchTab pushes
  // history entries, so popstate has to re-read ?tab=.
  function onPopState(): void {
    const raw = new URLSearchParams(window.location.search).get("tab");
    activeTab = raw && (TAB_IDS as string[]).includes(raw) ? (raw as TabId) : "inbox";
  }

  function switchTab(next: TabId): void {
    activeTab = next;
    const url = new URL(window.location.href);
    if (next === "inbox") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.pushState({}, "", url);
  }
</script>

<svelte:window onpopstate={onPopState} />

<div class="space-y-8">
  <PageHeader
    eyebrow="System"
    title="Alerts"
    description="Proactive alerts for readiness transitions and net-worth drops — in your inbox and on Discord."
  />

  <nav aria-label="Alerts sections" class="-mx-4 overflow-x-auto px-4 pb-1 md:mx-0 md:overflow-visible md:px-0">
    <div class="flex gap-1 rounded-full border border-border bg-surface p-1 md:w-fit" role="tablist">
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === t.id}
          class="shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition-all {activeTab === t.id
            ? 'bg-fg font-semibold text-bg'
            : 'text-fg-muted hover:text-fg'}"
          onclick={() => switchTab(t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>
  </nav>

  <div>
    {#if activeTab === "inbox"}
      <AlertsInbox />
    {:else if activeTab === "rules"}
      <AlertsRules />
    {:else}
      <AlertsChannels />
    {/if}
  </div>
</div>
