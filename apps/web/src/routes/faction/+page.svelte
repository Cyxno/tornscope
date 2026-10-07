<script lang="ts">
  import { createLoadGuard } from "$lib/loadGuard";
  import { goto } from "$app/navigation";
  import type { FactionOverviewResponse, FactionRankedWarsResponse, FactionMembersResponse, FactionOcsResponse, FactionLedgerResponse, FactionOcRow } from "@tornscope/shared";
  import { formatMoneyCompact, formatSignedMoney, formatDecimal, ocParticipationState, OC_PARTICIPATION_LABELS, OC_PARTICIPATION_HINTS, userInAnyKnownOc } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import { availabilityMessage, availabilityHasData } from "$lib/capabilities";
  import * as td from "$lib/time-display.svelte.js";

  type Tab = "overview" | "wars" | "members" | "oc" | "ledger";

  let tab = $state<Tab>("overview");
  let overview = $state<FactionOverviewResponse | null>(null);
  let wars = $state<FactionRankedWarsResponse | null>(null);
  let members = $state<FactionMembersResponse | null>(null);
  let ocs = $state<FactionOcsResponse | null>(null);
  let ledger = $state<FactionLedgerResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const guard = createLoadGuard();
  async function load() {
    const seq = guard.begin();
    loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      const activeTab = tab;
      const [ov, extra] = await Promise.all([
        endpoints.factionOverview(range),
        activeTab === "wars" ? endpoints.factionRankedWars(range)
        : activeTab === "members" ? endpoints.factionMembers(range)
        : activeTab === "oc" ? endpoints.factionOcs(range)
        : activeTab === "ledger" ? endpoints.factionLedger(range)
        : Promise.resolve(null),
      ]);
      if (!guard.isCurrent(seq)) return; // a newer range/tab superseded this response
      overview = ov;
      if (extra !== null) {
        if (activeTab === "wars") wars = extra as typeof wars;
        else if (activeTab === "members") members = extra as typeof members;
        else if (activeTab === "oc") ocs = extra as typeof ocs;
        else if (activeTab === "ledger") ledger = extra as typeof ledger;
      }
    } catch (err) {
      if (!guard.isCurrent(seq)) return;
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      if (guard.isCurrent(seq)) loading = false;
    }
  }

  function setTab(t: Tab) {
    tab = t;
    void load();
  }

  $effect(() => {
    void dateRange.preset;
    void dateRange.from;
    void reloadToken;
    void load();
  });

  // Chains were folded into Overview (latest chain); the chains API and stored
  // data remain available — the tab only hid rows of numbers with no action.
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "wars", label: "Ranked Wars" },
    { id: "members", label: "Members" },
    { id: "oc", label: "Organized Crime" },
    { id: "ledger", label: "Finance" },
  ];

  const resultBadge = (r: string) =>
    r === "win" ? "chip-positive" : r === "loss" ? "chip-negative" : "";

  function payoutKindLabel(kind: string, scenario: string | null): string {
    return kind === "oc" ? `OC payout${scenario ? ` · ${scenario}` : ""}` : "Unmatched faction payout";
  }

  // Faction permissions are independent of user permissions: each tab checks
  // its own capability instead of assuming Full access covers everything.
  const av = $derived(overview?.availability);
  const basicBlocked = $derived(av?.basic !== undefined && !availabilityHasData(av.basic));
  const basicMsg = $derived(av?.basic ? availabilityMessage(av.basic) : null);
  const blockedForTab = $derived.by((): ReturnType<typeof availabilityMessage> | null => {
    if (!av) return null;
    const entry: Record<Tab, typeof av.basic | undefined> = {
      overview: av.basic,
      wars: av.rankedWars,
      members: av.members,
      oc: av.organizedCrimes,
      ledger: av.balance,
    };
    const current = entry[tab];
    return current && !availabilityHasData(current) ? availabilityMessage(current) : null;
  });
</script>

<svelte:head><title>Faction · TornScope</title></svelte:head>

<div class="space-y-8 lg:space-y-10">
  <PageHeader
    eyebrow="Faction"
    title={overview?.faction.name ?? "Faction"}
    description="Your faction at a glance — wars, roster, organized crime and the money that actually reached you."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !overview}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load faction analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if overview && basicBlocked && basicMsg}
    <!-- Faction access is a separate key grant; explain instead of showing empty factions -->
    <StateMessage
      state={basicMsg.state}
      title={basicMsg.title}
      hint={`${basicMsg.hint} Faction permissions differ from personal ones — your key needs the Faction selections (ask your faction leader to enable API access).`}
      action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
    />
  {:else if overview}
    {#if blockedForTab}
      <StateMessage
        state={blockedForTab.state}
        title={blockedForTab.title}
        hint={blockedForTab.hint}
        action={{ label: "Review API access in Settings", run: () => void goto("/settings?tab=api") }}
      />
    {/if}
    <div class="flex flex-wrap gap-1 rounded-full border border-border bg-surface p-1">
      {#each tabs as t (t.id)}
        <button
          class="rounded-full px-3.5 py-1.5 text-xs font-medium transition-all {tab === t.id ? 'bg-fg font-semibold text-bg' : 'text-fg-muted hover:text-fg'}"
          onclick={() => setTab(t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    {#if tab === "overview"}
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Respect" value={overview.faction.respect !== null ? overview.faction.respect.toLocaleString("en-US") : "—"} provenance="exact" tone="accent" sub={overview.faction.members !== null ? `${overview.faction.members} members` : null} />
        <Stat label="Best chain" value={overview.faction.bestChain !== null ? String(overview.faction.bestChain) : "—"} provenance="exact" sub={overview.currentChain ? `latest chain ${overview.currentChain.chain}` : null} />
        <Stat label="Wars in range" value={String(overview.wars.total)} provenance="exact" sub={`${overview.wars.wins}W · ${overview.wars.losses}L${overview.wars.ongoing > 0 ? ` · ${overview.wars.ongoing} ongoing` : ""}`} />
        <Stat
          label="My faction income"
          value={formatMoneyCompact(overview.payouts.ocTotal + overview.payouts.unmatchedTotal + overview.payouts.knownTotal)}
          provenance="derived"
          sub={`OC ${formatMoneyCompact(overview.payouts.ocTotal)} · ranked war ${formatMoneyCompact(overview.payouts.knownTotal)} · unmatched ${formatMoneyCompact(overview.payouts.unmatchedTotal)}`}
        />
      </div>
      <p class="text-xs text-fg-faint">
        Faction income is labelled by what it actually is: rows carrying OC scenario metadata are <span class="font-medium text-fg">OC payouts</span>;
        only rows matched to a ranked war count as war payouts — the rest is <span class="font-medium text-fg">unmatched faction income</span>.
      </p>

      {#if overview.factionTrend && overview.factionTrend.series.length > 1}
        <Panel
          title="Faction history — respect & members over time"
          caption={`From ${overview.factionTrend.delta.points} stored snapshots${overview.factionTrend.delta.trackingSince !== null ? ` since ${td.displayDate(overview.factionTrend.delta.trackingSince)}` : ""} — every point is a real stored snapshot`}
          flush
        >
          <div class="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
            <div class="bg-surface px-4 py-3">
              <p class="text-[11px] text-fg-faint">Respect now</p>
              <p class="tnum mt-0.5 text-[15px] font-semibold text-fg">{overview.factionTrend.delta.respect.closing !== null ? overview.factionTrend.delta.respect.closing.toLocaleString("en-US") : "—"}</p>
            </div>
            <div class="bg-surface px-4 py-3">
              <p class="text-[11px] text-fg-faint">Respect change{overview.factionTrend.delta.respect.ratePerDay !== null ? "" : ""}</p>
              <p class="tnum mt-0.5 text-[15px] font-semibold {overview.factionTrend.delta.respect.delta !== null ? (overview.factionTrend.delta.respect.delta >= 0 ? 'text-positive' : 'text-negative') : 'text-fg-faint'}">
                {overview.factionTrend.delta.respect.delta !== null ? (overview.factionTrend.delta.respect.delta >= 0 ? "+" : "") + overview.factionTrend.delta.respect.delta.toLocaleString("en-US") : "—"}
              </p>
              <p class="text-[10px] text-fg-faint">{overview.factionTrend.delta.respect.ratePerDay !== null ? `${overview.factionTrend.delta.respect.ratePerDay >= 0 ? "+" : ""}${overview.factionTrend.delta.respect.ratePerDay.toFixed(1)}/day` : ""}</p>
            </div>
            <div class="bg-surface px-4 py-3">
              <p class="text-[11px] text-fg-faint">Members now</p>
              <p class="tnum mt-0.5 text-[15px] font-semibold text-fg">{overview.factionTrend.delta.members.closing !== null ? String(overview.factionTrend.delta.members.closing) : "—"}</p>
            </div>
            <div class="bg-surface px-4 py-3">
              <p class="text-[11px] text-fg-faint">Member change</p>
              <p class="tnum mt-0.5 text-[15px] font-semibold {overview.factionTrend.delta.members.delta !== null ? (overview.factionTrend.delta.members.delta >= 0 ? 'text-positive' : 'text-negative') : 'text-fg-faint'}">
                {overview.factionTrend.delta.members.delta !== null ? (overview.factionTrend.delta.members.delta >= 0 ? "+" : "") + String(overview.factionTrend.delta.members.delta) : "—"}
              </p>
            </div>
          </div>
          <p class="mt-3 text-[11px] leading-relaxed text-fg-faint">
            Snapshot-derived, exact provenance: the deltas span the tracked snapshots only — never a fabricated join/leave date.
          </p>
        </Panel>
      {/if}

      {#if overview.currentWar}
        <Panel title="Current ranked war" caption="Live state from Torn" flush>
          <div class="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Opponent</p><p class="mt-1 font-medium text-fg">{overview.currentWar.opponentName ?? "—"}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Score</p><p class="tnum mt-1 font-medium text-fg">{overview.currentWar.ourScore ?? "—"} : {overview.currentWar.opponentScore ?? "—"}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Target</p><p class="tnum mt-1 font-medium text-fg">{overview.currentWar.targetScore ?? "—"}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">My war activity</p><p class="tnum mt-1 font-medium text-fg">{overview.currentWar.myAttacks} outgoing attacks · {formatDecimal(overview.currentWar.myRespect)} respect</p></div>
          </div>
        </Panel>
      {/if}

      <Panel title="Recent ranked wars" caption="Newest first — full details under the Ranked Wars tab" flush>
        {#if overview.recentWars.length === 0}
          <StateMessage state="empty" title="No ranked wars stored yet" hint="Wars are collected by the ranked_wars sync resource." />
        {:else}
        <div class="overflow-x-auto px-2 pb-4">
          <table class="tsv-table">
            <thead>
              <tr>
                <th class="font-medium">Started</th>
                <th class="font-medium">Opponent</th>
                <th class="font-medium">Result</th>
                <th class="text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {#each overview.recentWars as w (w.tornWarId)}
                <tr>
                  <td class="tnum whitespace-nowrap text-xs text-fg-faint">{td.displayDate(w.startedAt)}</td>
                  <td class="text-fg">{w.opponentName ?? "—"}</td>
                  <td class="py-2 pr-4"><span class={`chip ${resultBadge(w.result)}`}>{w.result}</span></td>
                  <td class="tnum text-right text-fg-muted">{w.ourScore ?? "—"} : {w.opponentScore ?? "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="px-6 pb-4 text-xs text-fg-faint">Showing the latest {overview.recentWars.length} of {overview.wars.total} stored wars.</p>
        {/if}
      </Panel>
    {:else if tab === "wars" && wars}
      <Panel title="Ranked wars — detailed" caption="Personal stats derived from your ranked-war attacks; payouts matched by time window" flush>
        {#if wars.wars.length === 0}
          <StateMessage state="empty" title="No ranked wars in this range" />
        {:else}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th class="font-medium">Started</th>
                  <th class="font-medium">Opponent</th>
                  <th class="font-medium">Result</th>
                  <th class="text-right font-medium">Score</th>
                  <th class="text-right font-medium">My attacks</th>
                  <th class="text-right font-medium">My respect</th>
                  <th class="text-right font-medium">War payouts (matched)</th>
                  <th class="text-right font-medium">My payout</th>
                </tr>
              </thead>
              <tbody>
                {#each wars.wars as w (w.tornWarId)}
                  <tr>
                    <td class="tnum whitespace-nowrap text-xs text-fg-faint">{td.displayDateTime(w.startedAt)}</td>
                    <td class="text-fg">{w.opponentName ?? "—"}</td>
                    <td class=""><span class={`chip ${resultBadge(w.result)}`}>{w.result}</span></td>
                    <td class="tnum text-right text-fg-muted">{w.ourScore ?? "—"} : {w.opponentScore ?? "—"}</td>
                    <td class="tnum text-right text-fg-muted">{w.myAttacks}</td>
                    <td class="tnum text-right text-fg-muted">{formatDecimal(w.myRespect)}</td>
                    <td class="tnum text-right text-fg-muted">{formatMoneyCompact(w.knownPayoutTotal)}</td>
                    <td class="tnum text-right font-medium {w.personalPayout !== null ? 'text-positive' : 'text-fg-faint'}">{w.personalPayout !== null ? formatMoneyCompact(w.personalPayout) : "unmatched"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>
    {:else if tab === "members" && members}
      <Panel title="Roster" caption="Stored from the faction members sync — war stats derived from your own ranked-war attacks" flush>
        {#if members.members.length === 0}
          <StateMessage state="empty" title="No faction roster stored yet" hint="Members sync with the faction resource." />
        {:else}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th class="font-medium">Member</th>
                  <th class="font-medium">Position</th>
                  <th class="text-right font-medium">Level</th>
                  <th class="text-right font-medium">Days in faction</th>
                  <th class="font-medium">Last action</th>
                  <th class="text-right font-medium">My war attacks</th>
                  <th class="text-right font-medium">My war respect</th>
                </tr>
              </thead>
              <tbody>
                {#each members.members as m (m.memberId)}
                  <tr>
                    <td class="">
                      <span class="font-medium text-fg">{m.name ?? `Member ${m.memberId}`}</span>
                      {#if m.isCurrentUser}<span class="chip chip-accent ml-2 !text-[10px]">you</span>{/if}
                    </td>
                    <td class="text-fg-muted">{m.position ?? "—"}</td>
                    <td class="tnum text-right text-fg-muted">{m.level ?? "—"}</td>
                    <td class="tnum text-right text-fg-muted">{m.daysInFaction ?? "—"}</td>
                    <td class="text-xs text-fg-faint">
                      {#if m.status || m.lastActionAt}
                        {m.status ?? "—"}{m.lastActionAt ? ` · ${td.displayDate(m.lastActionAt)}` : ""}
                      {:else}
                        —
                      {/if}
                    </td>
                    <td class="tnum text-right text-fg-muted">{m.warAttacks}</td>
                    <td class="tnum text-right text-fg-muted">{formatDecimal(m.warRespect)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="px-6 pt-3 text-xs text-fg-faint">War attacks/respect are only attributable to your own attacks (Torn attack rows carry no faction-member ids) — everyone else keeps honest zeros.</p>
        {/if}
      </Panel>
    {:else if tab === "oc" && ocs}
      {@const active = ocs.ocs.filter((o) => o.state === "active")}
      {@const inAnyOc = userInAnyKnownOc(active)}
      {@const mine = active.filter((o) => o.myParticipation)}
      {@const others = active.filter((o) => !o.myParticipation)}
      {@const completed = ocs.ocs.filter((o) => o.state === "completed")}
      {@const expired = ocs.ocs.filter((o) => o.state === "expired")}

      {#snippet participationCell(oc: FactionOcRow, contextual = true)}
        {@const state = ocParticipationState(oc, { userInAnyKnownOc: contextual ? inAnyOc : false })}
        {@const hint = OC_PARTICIPATION_HINTS[state]}
        {#if state === "participating"}
          <span class="chip chip-accent font-medium">{contextual ? OC_PARTICIPATION_LABELS.participating : "You participated"}</span>
        {:else if state === "assigned_elsewhere"}
          <span class="text-xs text-fg-muted" title={hint ?? undefined}>{OC_PARTICIPATION_LABELS.assigned_elsewhere}</span>
        {:else if state === "not_participating"}
          <span class="text-xs text-fg-faint">{OC_PARTICIPATION_LABELS.not_participating}</span>
        {:else}
          <span class="text-xs text-fg-faint" title={hint ?? undefined}>{OC_PARTICIPATION_LABELS.unavailable}</span>
        {/if}
      {/snippet}

      <!-- Your organized crime: explicit, first-class -->
      <Panel title="Your organized crime" caption="Active crimes where the participant data includes your Torn ID" flush>
        {#if mine.length === 0}
          <div class="px-6 pb-6 pt-2">
            <StateMessage
              state="empty"
              title={active.some((o) => o.participantsIdentifiable) ? "You are not currently assigned to an organized crime." : "Your organized crime assignment cannot be determined with the current API permissions."}
              hint={active.some((o) => o.participantsIdentifiable) ? "When a faction slot lists you, the crime appears here." : "The stored payloads carry no participant lists — grant Faction Crimes access in Torn so membership can be read."}
            />
          </div>
        {:else}
          <div class="divide-y divide-border">
            {#each mine as oc (oc.ocId)}
              <div class="px-6 py-4">
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span class="text-[15px] font-semibold text-fg">{oc.name}</span>
                  {#if oc.tier !== null}
                    <span class="chip chip-info" title="Torn difficulty rating — the tier number of this scenario">Tier {oc.tier}</span>
                  {/if}
                  <span class="chip">{oc.status}</span>
                  <span class="tnum text-xs text-fg-muted" title="Slots with a listed participant out of total slots">{oc.slotsFilled} / {oc.slotsTotal} slots filled</span>
                  {#if oc.myPosition}
                    <span class="chip chip-accent" title="Your slot in this crime">Your role: {oc.myPosition}</span>
                  {/if}
                  {#if oc.readyAt}
                    <span class="text-xs text-fg-faint">Ready {td.displayDateTime(oc.readyAt)}</span>
                  {:else if oc.planningAt}
                    <span class="text-xs text-fg-faint">Planning since {td.displayDateTime(oc.planningAt)}</span>
                  {/if}
                  <span class="ml-auto">{@render participationCell(oc)}</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </Panel>

      <!-- Other active organized crimes: slot availability + contextual status -->
      <Panel title="Other active organized crimes" caption={`${others.length} other crime${others.length === 1 ? "" : "s"} — slot availability is separate from your participation`} flush>
        {#if others.length === 0}
          <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="No other active organized crimes" /></div>
        {:else}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th class="font-medium">Crime</th>
                  <th class="font-medium">Tier</th>
                  <th class="font-medium">Status</th>
                  <th class="font-medium">Slots</th>
                  <th class="font-medium">Ready / start</th>
                  <th class="font-medium">Your status</th>
                </tr>
              </thead>
              <tbody>
                {#each others.slice(0, 20) as oc (oc.ocId)}
                  <tr>
                    <td class="font-medium text-fg">{oc.name}</td>
                    <td class="">{#if oc.tier !== null}<span class="text-fg-muted">Tier {oc.tier}</span>{:else}<span class="text-xs text-fg-faint">Tier unavailable</span>{/if}</td>
                    <td class=""><span class="chip">{oc.status}</span></td>
                    <td class="">
                      <span class="tnum text-fg-muted">{oc.slotsFilled}/{oc.slotsTotal}</span>
                      {#if oc.slotsFilled >= oc.slotsTotal && oc.slotsTotal > 0}
                        <span class="chip ml-1.5 !text-[10px]">Full</span>
                      {:else}
                        <span class="ml-1.5 text-[11px] text-fg-faint">{oc.slotsTotal - oc.slotsFilled} open</span>
                      {/if}
                    </td>
                    <td class="text-xs text-fg-faint">
                      {#if oc.readyAt}{td.displayDateTime(oc.readyAt)}
                      {:else if oc.planningAt}planning since {td.displayDateTime(oc.planningAt)}
                      {:else}—{/if}
                    </td>
                    <td class="">{@render participationCell(oc)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="px-6 pt-3 text-xs text-fg-faint">
            Slot counts come from the faction crime payload; your status comes from participant data. Open slots never
            imply anything about your participation, and an empty roster positively shows you are not in it.
          </p>
        {/if}
      </Panel>

      <!-- Completed: rewards exist (money can honestly be $0) -->
      <Panel title="Completed" caption={`${completed.length} executed crime${completed.length === 1 ? "" : "s"} — actual rewards as reported by Torn`} flush>
        {#if completed.length === 0}
          <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="No completed organized crimes in the stored history" /></div>
        {:else}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th class="font-medium">Crime</th>
                  <th class="font-medium">Tier</th>
                  <th class="font-medium">Result</th>
                  <th class="font-medium">Executed</th>
                  <th class="font-medium">Actual rewards</th>
                  <th class="text-right font-medium">Respect</th>
                  <th class="text-right font-medium">Est. total value</th>
                  <th class="font-medium">Participation</th>
                </tr>
              </thead>
              <tbody>
                {#each completed.slice(0, 30) as oc (oc.ocId)}
                  {@const hasItems = (oc.rewardItemsDetailed?.length ?? 0) > 0}
                  <tr>
                    <td class="font-medium text-fg">{oc.name}</td>
                    <td class="">{#if oc.tier !== null}<span class="text-fg-muted">Tier {oc.tier}</span>{:else}<span class="text-xs text-fg-faint">—</span>{/if}</td>
                    <td class="">
                      <span class={`chip ${oc.status === "Successful" ? "chip-positive" : "chip-negative"}`}>{oc.status}</span>
                    </td>
                    <td class="tnum whitespace-nowrap text-xs text-fg-faint">{oc.executedAt ? td.displayDateTime(oc.executedAt) : "—"}</td>
                    <td class="">
                      {#if oc.rewardMoney === null && !hasItems && oc.rewardRespect === null}
                        <span class="text-xs text-fg-faint">—</span>
                      {:else}
                        <div class="space-y-0.5 text-xs">
                          <!-- Torn's $0 cash is a real reported value; items/respect are the actual reward -->
                          <p class={oc.rewardMoney ? "text-fg-muted" : "text-fg-faint"}>
                            Cash <span class="tnum">{oc.rewardMoney !== null ? formatMoneyCompact(oc.rewardMoney) : "—"}</span>
                            {#if oc.rewardMoney === 0 && (hasItems || (oc.rewardRespect ?? 0) > 0)}
                              <span class="text-fg-faint">· paid in items/respect</span>
                            {/if}
                          </p>
                          {#if hasItems}
                            {#each oc.rewardItemsDetailed! as item (item.itemId + ":" + item.quantity)}
                              <p class="text-fg-muted">
                                {item.quantity} × {item.name}
                                {#if item.estimatedValue !== null}
                                  <span class="tnum text-fg-faint">({formatMoneyCompact(item.estimatedValue)})</span>
                                {/if}
                              </p>
                            {/each}
                          {/if}
                        </div>
                      {/if}
                    </td>
                    <td class="tnum text-right text-fg-muted">{oc.rewardRespect !== null ? formatDecimal(oc.rewardRespect) : "—"}</td>
                    <td class="tnum text-right text-fg-muted">
                      {#if oc.rewardEstimatedTotal !== null}
                        {formatMoneyCompact(oc.rewardEstimatedTotal)}{#if !oc.rewardValueComplete}<span class="text-fg-faint" title="Some reward items have no catalog price — the total covers priced items only.">*</span>{/if}
                      {:else}
                        <span class="text-fg-faint" title="No priced reward items to estimate">—</span>
                      {/if}
                    </td>
                    <td class="">{@render participationCell(oc, false)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="px-6 pt-3 text-xs text-fg-faint">
            Cash is Torn-reported; item values are estimated from the Torn catalog. A $0 cash reward is a real reported
            value — most OC 2.0 payouts pay in respect and items instead. "Est. total value" combines reported cash with
            priced items; items without a catalog price are listed but not valued.
          </p>
        {/if}
      </Panel>

      <!-- Expired / cancelled: no execution, no rewards — never rendered as empty reward columns -->
      <Panel title="Expired / cancelled" caption="Crimes that expired or were cancelled before execution — no rewards exist" flush>
        {#if expired.length === 0}
          <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="Nothing expired" /></div>
        {:else}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th class="font-medium">Crime</th>
                  <th class="font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {#each expired.slice(0, 20) as oc (oc.ocId)}
                  <tr>
                    <td class="text-fg-muted">{oc.name}</td>
                    <td class="text-xs text-fg-faint">{oc.status}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if expired.length > 20}
            <p class="px-6 pt-3 text-xs text-fg-faint">+{expired.length - 20} more expired crimes stored.</p>
          {/if}
        {/if}
      </Panel>
    {:else if tab === "ledger" && ledger}
      <p class="text-xs text-fg-faint">
        Faction bank snapshots stay collected in the background (latest: {ledger.snapshots.length > 0 ? `${formatMoneyCompact(ledger.snapshots[ledger.snapshots.length - 1]!.money)} · ${td.displayDate(ledger.snapshots[ledger.snapshots.length - 1]!.capturedAt)}` : "—"})
        — the actionable view is your labeled income below.
      </p>
      <Panel title="My faction income" caption="Canonical personal ledger rows — labelled by their actual source" flush>
        {#if ledger.payouts.length === 0}
          <StateMessage state="empty" title="No faction income in this range" />
        {:else}
          <div class="overflow-x-auto">
            <table class="tsv-table">
              <thead>
                <tr>
                  <th class="font-medium">When</th>
                  <th class="font-medium">Source</th>
                  <th class="font-medium">Description</th>
                  <th class="text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {#each ledger.payouts.slice(0, 30) as p (p.sourceRef)}
                  <tr>
                    <td class="tnum whitespace-nowrap text-xs text-fg-faint">{td.displayDateTime(p.occurredAt)}</td>
                    <td class="">
                      {#if p.kind === "oc"}
                        <span class="chip chip-info whitespace-nowrap">OC payout{p.scenario ? ` · ${p.scenario}` : ""}</span>
                      {:else}
                        <span class="chip whitespace-nowrap">Unmatched faction payout</span>
                      {/if}
                    </td>
                    <td class="max-w-[300px] truncate text-fg" title={p.description ?? ""}>{p.description ?? "—"}</td>
                    <td class="tnum text-right font-medium {p.amount >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedMoney(p.amount)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="px-6 pt-3 text-xs text-fg-faint">
            “Unmatched faction payout” has no confirmed ranked-war or OC linkage — it is never presented as a war payout.
          </p>
        {/if}
      </Panel>
    {/if}
  {/if}
</div>
