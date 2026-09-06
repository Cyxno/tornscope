<script lang="ts">
  import type { FactionOverviewResponse, FactionRankedWarsResponse, FactionMembersResponse, FactionChainsResponse, FactionOcsResponse, FactionLedgerResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatDateTime, formatSignedMoney, formatDuration, formatDate } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { dateRange } from "$lib/state.svelte";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import Stat from "$lib/components/Stat.svelte";
  import SegmentedDateRange from "$lib/components/SegmentedDateRange.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  type Tab = "overview" | "wars" | "members" | "chains" | "oc" | "ledger";

  let tab = $state<Tab>("overview");
  let overview = $state<FactionOverviewResponse | null>(null);
  let wars = $state<FactionRankedWarsResponse | null>(null);
  let members = $state<FactionMembersResponse | null>(null);
  let chains = $state<FactionChainsResponse | null>(null);
  let ocs = $state<FactionOcsResponse | null>(null);
  let ledger = $state<FactionLedgerResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  async function load() {
    loading = true;
    error = null;
    try {
      const range = { preset: dateRange.preset, from: dateRange.from, to: dateRange.to };
      overview = await endpoints.factionOverview(range);
      if (tab === "wars") wars = await endpoints.factionRankedWars(range);
      if (tab === "members") members = await endpoints.factionMembers(range);
      if (tab === "chains") chains = await endpoints.factionChains(range);
      if (tab === "oc") ocs = await endpoints.factionOcs(range);
      if (tab === "ledger") ledger = await endpoints.factionLedger(range);
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
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

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "wars", label: "Ranked Wars" },
    { id: "members", label: "Members" },
    { id: "chains", label: "Chains" },
    { id: "oc", label: "Organized Crime" },
    { id: "ledger", label: "Finance" },
  ];

  const resultBadge = (r: string) =>
    r === "win" ? "border-positive/30 bg-positive/10 text-positive" : r === "loss" ? "border-negative/30 bg-negative/10 text-negative" : "border-border bg-surface-2 text-fg-muted";

  /** "Mine" is only answerable when the payload carries participant ids. */
  function mineState(oc: { myParticipation: boolean; participantsIdentifiable: boolean }): "unavailable" | "mine" | "no" {
    if (!oc.participantsIdentifiable) return "unavailable";
    return oc.myParticipation ? "mine" : "no";
  }

  function payoutKindLabel(kind: string, scenario: string | null): string {
    return kind === "oc" ? `OC payout${scenario ? ` · ${scenario}` : ""}` : "Unmatched faction income";
  }
</script>

<div class="space-y-10">
  <PageHeader
    eyebrow="Faction"
    title={overview?.faction.name ?? "Faction"}
    description="Ranked wars, members, chains, organized crime and faction finance — exact where Torn provides it, honest where it doesn't."
  >
    {#snippet actions()}
      <SegmentedDateRange />
    {/snippet}
  </PageHeader>

  {#if loading && !overview}
    <StateMessage state="loading" />
  {:else if error}
    <StateMessage state="error" title="Could not load faction analytics" hint={error} action={{ label: "Retry", run: () => (reloadToken += 1) }} />
  {:else if overview}
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
      <div class="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border shadow-panel md:grid-cols-4">
        <Stat label="Respect" value={overview.faction.respect !== null ? overview.faction.respect.toLocaleString() : "—"} provenance="exact" tone="accent" sub={overview.faction.members !== null ? `${overview.faction.members} members` : null} />
        <Stat label="Best chain" value={overview.faction.bestChain !== null ? String(overview.faction.bestChain) : "—"} provenance="exact" sub={overview.currentChain ? `latest chain ${overview.currentChain.chain}` : null} />
        <Stat label="Wars in range" value={String(overview.wars.total)} provenance="exact" sub={`${overview.wars.wins}W · ${overview.wars.losses}L${overview.wars.ongoing > 0 ? ` · ${overview.wars.ongoing} ongoing` : ""}`} />
        <Stat
          label="My faction income"
          value={formatMoneyCompact(overview.payouts.ocTotal + overview.payouts.unmatchedTotal + overview.payouts.knownTotal)}
          provenance="derived"
          sub={`OC ${formatMoneyCompact(overview.payouts.ocTotal)} · war-linked ${formatMoneyCompact(overview.payouts.knownTotal)} · unmatched ${formatMoneyCompact(overview.payouts.unmatchedTotal)}`}
        />
      </div>
      <p class="text-xs text-fg-faint">
        Faction income is labelled by what it actually is: rows carrying OC scenario metadata are <span class="font-medium text-fg">OC payouts</span>;
        only rows matched to a ranked war count as war payouts — the rest is <span class="font-medium text-fg">unmatched faction income</span>.
      </p>

      {#if overview.currentWar}
        <Panel title="Current ranked war" caption="Live state from Torn" flush>
          <div class="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Opponent</p><p class="mt-1 font-medium text-fg">{overview.currentWar.opponentName ?? "—"}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Score</p><p class="tnum mt-1 font-medium text-fg">{overview.currentWar.ourScore ?? "—"} : {overview.currentWar.opponentScore ?? "—"}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Target</p><p class="tnum mt-1 font-medium text-fg">{overview.currentWar.targetScore ?? "—"}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">My war activity</p><p class="tnum mt-1 font-medium text-fg">{overview.currentWar.myAttacks} attacks · {overview.currentWar.myRespect} respect</p></div>
          </div>
        </Panel>
      {/if}

      {#if overview.balance}
        <Panel title="Faction bank" caption="Snapshot from Torn faction balance" flush>
          <div class="grid grid-cols-2 gap-px bg-border md:grid-cols-3">
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Faction money</p><p class="tnum mt-1 font-semibold text-fg">{formatMoneyCompact(overview.balance.money)}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Points</p><p class="tnum mt-1 font-semibold text-fg">{overview.balance.points ?? "—"}</p></div>
            <div class="bg-surface p-5 text-center"><p class="text-[10px] uppercase tracking-[0.14em] text-fg-faint">Snapshot</p><p class="mt-1 text-xs text-fg-muted">{formatDateTime(overview.balance.capturedAt)}</p></div>
          </div>
        </Panel>
      {/if}

      <Panel title="Recent ranked wars" caption="Newest first — full details under the Ranked Wars tab" flush>
        {#if overview.recentWars.length === 0}
          <StateMessage state="empty" title="No ranked wars stored yet" hint="Wars are collected by the ranked_wars sync resource." />
        {:else}
        <div class="overflow-x-auto px-2 pb-4">
          <table class="w-full text-left text-[13px]">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                <th class="py-2 pl-4 pr-4 font-medium">Started</th>
                <th class="py-2 pr-4 font-medium">Opponent</th>
                <th class="py-2 pr-4 font-medium">Result</th>
                <th class="py-2 pr-4 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {#each overview.recentWars as w (w.tornWarId)}
                <tr class="border-b border-border/40 last:border-0">
                  <td class="tnum whitespace-nowrap py-2 pl-4 pr-4 text-xs text-fg-faint">{formatDate(w.startedAt)}</td>
                  <td class="py-2 pr-4 text-fg">{w.opponentName ?? "—"}</td>
                  <td class="py-2 pr-4"><span class={`rounded-full border px-2 py-0.5 text-[11px] ${resultBadge(w.result)}`}>{w.result}</span></td>
                  <td class="tnum py-2 pr-4 text-right text-fg-muted">{w.ourScore ?? "—"} : {w.opponentScore ?? "—"}</td>
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
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Started</th>
                  <th class="py-2.5 pr-4 font-medium">Opponent</th>
                  <th class="py-2.5 pr-4 font-medium">Result</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Score</th>
                  <th class="py-2.5 pr-4 text-right font-medium">My attacks</th>
                  <th class="py-2.5 pr-4 text-right font-medium">My respect</th>
                  <th class="py-2.5 pr-4 text-right font-medium">War payouts (matched)</th>
                  <th class="py-2.5 pr-6 text-right font-medium">My payout</th>
                </tr>
              </thead>
              <tbody>
                {#each wars.wars as w (w.tornWarId)}
                  <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                    <td class="tnum whitespace-nowrap py-2.5 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(w.startedAt)}</td>
                    <td class="py-2.5 pr-4 text-fg">{w.opponentName ?? "—"}</td>
                    <td class="py-2.5 pr-4"><span class={`rounded-full border px-2 py-0.5 text-[11px] ${resultBadge(w.result)}`}>{w.result}</span></td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{w.ourScore ?? "—"} : {w.opponentScore ?? "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{w.myAttacks}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{w.myRespect.toFixed(1)}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{formatMoneyCompact(w.knownPayoutTotal)}</td>
                    <td class="tnum py-2.5 pr-6 text-right font-medium {w.personalPayout !== null ? 'text-positive' : 'text-fg-faint'}">{w.personalPayout !== null ? formatMoneyCompact(w.personalPayout) : "unmatched"}</td>
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
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Member</th>
                  <th class="py-2.5 pr-4 font-medium">Position</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Level</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Days in faction</th>
                  <th class="py-2.5 pr-4 font-medium">Last action</th>
                  <th class="py-2.5 pr-4 text-right font-medium">My war attacks</th>
                  <th class="py-2.5 pr-6 text-right font-medium">My war respect</th>
                </tr>
              </thead>
              <tbody>
                {#each members.members as m (m.memberId)}
                  <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                    <td class="py-2.5 pl-6 pr-4">
                      <span class="font-medium text-fg">{m.name ?? `Member ${m.memberId}`}</span>
                      {#if m.isCurrentUser}<span class="ml-2 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">you</span>{/if}
                    </td>
                    <td class="py-2.5 pr-4 text-fg-muted">{m.position ?? "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{m.level ?? "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{m.daysInFaction ?? "—"}</td>
                    <td class="py-2.5 pr-4 text-xs text-fg-faint">
                      {#if m.status || m.lastActionAt}
                        {m.status ?? "—"}{m.lastActionAt ? ` · ${formatDate(m.lastActionAt)}` : ""}
                      {:else}
                        —
                      {/if}
                    </td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{m.warAttacks}</td>
                    <td class="tnum py-2.5 pr-6 text-right text-fg-muted">{m.warRespect.toFixed(1)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="px-6 pt-3 text-xs text-fg-faint">War attacks/respect are only attributable to your own attacks (Torn attack rows carry no faction-member ids) — everyone else keeps honest zeros.</p>
        {/if}
      </Panel>
    {:else if tab === "chains" && chains}
      <Panel title="Faction chains" caption="Historical chains with your participation" flush>
        {#if chains.chains.length === 0}
          <StateMessage state="empty" title="No chains stored in this range" hint="Chains sync from the faction chains endpoint." />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Started</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Max chain</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Respect</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Duration</th>
                  <th class="py-2.5 pr-4 text-right font-medium">My attacks</th>
                  <th class="py-2.5 pr-6 text-right font-medium">My respect</th>
                </tr>
              </thead>
              <tbody>
                {#each chains.chains as c (c.chainId)}
                  <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                    <td class="tnum whitespace-nowrap py-2.5 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(c.startedAt)}</td>
                    <td class="tnum py-2.5 pr-4 text-right font-medium text-fg">{c.chain}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{c.respect?.toFixed(1) ?? "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{formatDuration(c.durationSeconds)}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{c.myAttacks}</td>
                    <td class="tnum py-2.5 pr-6 text-right text-fg-muted">{c.myRespect.toFixed(1)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>
    {:else if tab === "oc" && ocs}
      {@const active = ocs.ocs.filter((o) => o.state === "active")}
      {@const completed = ocs.ocs.filter((o) => o.state === "completed")}
      {@const expired = ocs.ocs.filter((o) => o.state === "expired")}

      <!-- Active / planning: slots and progress are what matter -->
      <Panel title="Organized crimes — active / planning" caption={`${active.length} crime${active.length === 1 ? "" : "s"} currently recruiting or in planning`} flush>
        {#if active.length === 0}
          <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="No active organized crimes" /></div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Crime</th>
                  <th class="py-2.5 pr-4 font-medium">Status</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Slots filled</th>
                  <th class="py-2.5 pr-6 font-medium">Mine</th>
                </tr>
              </thead>
              <tbody>
                {#each active.slice(0, 20) as oc (oc.ocId)}
                  <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                    <td class="py-2.5 pl-6 pr-4 font-medium text-fg">{oc.name}</td>
                    <td class="py-2.5 pr-4"><span class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted">{oc.status}</span></td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{oc.participants.filter((p) => p.memberId !== null).length}/{oc.participants.length}</td>
                    <td class="py-2.5 pr-6">
                      {#if mineState(oc) === "mine"}
                        <span class="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Mine</span>
                      {:else if mineState(oc) === "unavailable"}
                        <span class="text-fg-faint">Unavailable</span>
                      {:else}
                        <span class="text-fg-faint">—</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>

      <!-- Completed: rewards exist (money can honestly be $0) -->
      <Panel title="Completed" caption={`${completed.length} executed crime${completed.length === 1 ? "" : "s"} — exact rewards from Torn`} flush>
        {#if completed.length === 0}
          <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="No completed organized crimes in the stored history" /></div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Crime</th>
                  <th class="py-2.5 pr-4 font-medium">Result</th>
                  <th class="py-2.5 pr-4 font-medium">Executed</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Reward cash</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Respect</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Items</th>
                  <th class="py-2.5 pr-6 font-medium">Mine</th>
                </tr>
              </thead>
              <tbody>
                {#each completed.slice(0, 30) as oc (oc.ocId)}
                  <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                    <td class="py-2.5 pl-6 pr-4 font-medium text-fg">{oc.name}</td>
                    <td class="py-2.5 pr-4">
                      <span class={`rounded-full border px-2 py-0.5 text-[11px] ${oc.status === "Successful" ? "border-positive/30 bg-positive/10 text-positive" : "border-negative/30 bg-negative/10 text-negative"}`}>{oc.status}</span>
                    </td>
                    <td class="tnum whitespace-nowrap py-2.5 pr-4 text-xs text-fg-faint">{oc.executedAt ? formatDateTime(oc.executedAt) : "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right {oc.rewardMoney !== null && oc.rewardMoney > 0 ? 'text-fg-muted' : 'text-fg-faint'}">{oc.rewardMoney !== null ? formatMoneyCompact(oc.rewardMoney) : "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{oc.rewardRespect !== null ? oc.rewardRespect : "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{oc.rewardItems ? oc.rewardItems.reduce((s, i) => s + i.quantity, 0) : "—"}</td>
                    <td class="py-2.5 pr-6">
                      {#if mineState(oc) === "mine"}
                        <span class="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Mine</span>
                      {:else if mineState(oc) === "unavailable"}
                        <span class="text-fg-faint">Unavailable</span>
                      {:else}
                        <span class="text-fg-faint">—</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="px-6 pt-3 text-xs text-fg-faint">
            Torn reports $0 reward cash for most OC 2.0 payouts (rewards are respect + items, split by payout percentage) — a $0 is Torn's own value, not missing data.
          </p>
        {/if}
      </Panel>

      <!-- Expired / cancelled: no execution, no rewards — never rendered as empty reward columns -->
      <Panel title="Expired / cancelled" caption={`${expired.length} crime${expired.length === 1 ? "" : "s"} that expired or was cancelled before execution — no rewards exist`} flush>
        {#if expired.length === 0}
          <div class="px-6 pb-6 pt-2"><StateMessage state="empty" title="Nothing expired" /></div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Crime</th>
                  <th class="py-2.5 pr-6 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {#each expired.slice(0, 20) as oc (oc.ocId)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2.5 pl-6 pr-4 text-fg-muted">{oc.name}</td>
                    <td class="py-2.5 pr-6 text-xs text-fg-faint">{oc.status}</td>
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
      <Panel title="Faction bank over time" caption="Snapshots of the faction balance (adaptive schedule)" flush>
        {#if ledger.snapshots.length === 0}
          <StateMessage state="empty" title="No balance snapshots in this range" hint="Snapshots accumulate as the faction sync runs." />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Captured</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Faction money</th>
                  <th class="py-2.5 pr-6 text-right font-medium">Points</th>
                </tr>
              </thead>
              <tbody>
                {#each ledger.snapshots.slice(-30).reverse() as s (s.capturedAt)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="tnum whitespace-nowrap py-2.5 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(s.capturedAt)}</td>
                    <td class="tnum py-2.5 pr-4 text-right font-medium text-fg">{formatMoneyCompact(s.money)}</td>
                    <td class="tnum py-2.5 pr-6 text-right text-fg-muted">{s.points ?? "—"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>
      <Panel title="My faction income" caption="Canonical personal ledger rows — labelled by their actual source" flush>
        {#if ledger.payouts.length === 0}
          <StateMessage state="empty" title="No faction income in this range" />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">When</th>
                  <th class="py-2.5 pr-4 font-medium">Source</th>
                  <th class="py-2.5 pr-4 font-medium">Description</th>
                  <th class="py-2.5 pr-6 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {#each ledger.payouts.slice(0, 30) as p (p.sourceRef)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="tnum whitespace-nowrap py-2.5 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(p.occurredAt)}</td>
                    <td class="py-2.5 pr-4">
                      {#if p.kind === "oc"}
                        <span class="whitespace-nowrap rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[11px] font-medium text-violet-300">OC payout{p.scenario ? ` · ${p.scenario}` : ""}</span>
                      {:else}
                        <span class="whitespace-nowrap rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted">Unmatched faction income</span>
                      {/if}
                    </td>
                    <td class="max-w-[300px] truncate py-2.5 pr-4 text-fg" title={p.description ?? ""}>{p.description ?? "—"}</td>
                    <td class="tnum py-2.5 pr-6 text-right font-medium {p.amount >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedMoney(p.amount)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="px-6 pt-3 text-xs text-fg-faint">
            “Unmatched faction income” has no confirmed ranked-war or OC linkage — it is never presented as a war payout.
          </p>
        {/if}
      </Panel>
    {/if}
  {/if}
</div>
