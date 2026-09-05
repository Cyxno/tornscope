<script lang="ts">
  import type { FactionOverviewResponse, FactionRankedWarsResponse, FactionMembersResponse, FactionChainsResponse, FactionOcsResponse, FactionLedgerResponse } from "@tornscope/shared";
  import { formatMoneyCompact, formatDateTime, formatSignedMoney, formatDuration } from "@tornscope/shared";
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
        <Stat label="Best chain" value={overview.faction.bestChain !== null ? String(overview.faction.bestChain) : "—"} provenance="exact" />
        <Stat label="Wars in range" value={String(overview.wars.total)} provenance="exact" sub={`${overview.wars.wins}W · ${overview.wars.losses}L${overview.wars.ongoing > 0 ? ` · ${overview.wars.ongoing} ongoing` : ""}`} />
        <Stat label="Known payouts" value={formatMoneyCompact(overview.payouts.knownTotal)} provenance="derived" sub={`my payout ${formatMoneyCompact(overview.payouts.personalTotal)}`} />
      </div>

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

      <Panel title="Ranked war history" caption="Newest first — full list under the Ranked Wars tab" flush>
        {#if overview.wars.total === 0}
          <StateMessage state="empty" title="No ranked wars stored yet" hint="Wars are collected by the ranked_wars sync resource." />
        {:else}
        <p class="px-6 pb-2 pt-3 text-xs text-fg-faint">Latest {Math.min(5, wars?.wars.length ?? 0)} of {overview.wars.total} — full details under the Ranked Wars tab.</p>
        <div class="overflow-x-auto px-2 pb-4">
          <table class="w-full text-left text-[13px]">
            <tbody>
              {#each (wars?.wars ?? []).slice(0, 5) as w (w.tornWarId)}
                <tr class="border-b border-border/40 last:border-0">
                  <td class="tnum whitespace-nowrap py-2 pl-4 pr-4 text-xs text-fg-faint">{formatDateTime(w.startedAt)}</td>
                  <td class="py-2 pr-4 text-fg">{w.opponentName ?? "—"}</td>
                  <td class="py-2 pr-4"><span class={`rounded-full border px-2 py-0.5 text-[11px] ${resultBadge(w.result)}`}>{w.result}</span></td>
                  <td class="tnum py-2 pr-4 text-right text-fg-muted">{w.ourScore ?? "—"} : {w.opponentScore ?? "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
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
                  <th class="py-2.5 pr-4 text-right font-medium">Known payouts</th>
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
      <Panel title="Roster" caption="Current members (war stats derived from ranked-war attacks in range)" flush>
        {#if members.members.length === 0}
          <StateMessage state="empty" title="No faction roster stored yet" hint="Members sync with the faction resource." />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Member</th>
                  <th class="py-2.5 pr-4 text-right font-medium">War attacks</th>
                  <th class="py-2.5 pr-4 text-right font-medium">War wins</th>
                  <th class="py-2.5 pr-4 text-right font-medium">War respect</th>
                </tr>
              </thead>
              <tbody>
                {#each members.members.slice(0, 60) as m (m.memberId)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="py-2.5 pl-6 pr-4 text-fg">{m.name ?? `Member ${m.memberId}`}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{m.warAttacks}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{m.warWins}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{m.warRespect.toFixed(1)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
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
      <Panel title="Organized crimes" caption="OC 2.0 records with exact rewards and your participation" flush>
        {#if ocs.ocs.length === 0}
          <StateMessage state="empty" title="No organized crimes stored" hint="OCs sync from the faction crimes endpoint." />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">Crime</th>
                  <th class="py-2.5 pr-4 font-medium">Status</th>
                  <th class="py-2.5 pr-4 font-medium">Executed</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Reward cash</th>
                  <th class="py-2.5 pr-4 text-right font-medium">Respect</th>
                  <th class="py-2.5 pr-6 font-medium">Mine</th>
                </tr>
              </thead>
              <tbody>
                {#each ocs.ocs.slice(0, 40) as oc (oc.ocId)}
                  <tr class="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                    <td class="py-2.5 pl-6 pr-4 text-fg">{oc.name}</td>
                    <td class="py-2.5 pr-4">
                      <span class={`rounded-full border px-2 py-0.5 text-[11px] ${oc.status === "Successful" ? "border-positive/30 bg-positive/10 text-positive" : oc.status === "Failure" ? "border-negative/30 bg-negative/10 text-negative" : "border-border bg-surface-2 text-fg-muted"}`}>{oc.status}</span>
                    </td>
                    <td class="tnum whitespace-nowrap py-2.5 pr-4 text-xs text-fg-faint">{oc.executedAt ? formatDateTime(oc.executedAt) : "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{oc.rewardMoney !== null ? formatMoneyCompact(oc.rewardMoney) : "—"}</td>
                    <td class="tnum py-2.5 pr-4 text-right text-fg-muted">{oc.rewardRespect ?? "—"}</td>
                    <td class="py-2.5 pr-6">{oc.myParticipation ? "✓" : ""}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
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
      <Panel title="My faction payouts" caption="Canonical personal ledger rows (category faction)" flush>
        {#if ledger.payouts.length === 0}
          <StateMessage state="empty" title="No faction payouts in this range" />
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-[13px]">
              <thead>
                <tr class="border-b border-border text-[11px] uppercase tracking-[0.12em] text-fg-faint">
                  <th class="py-2.5 pl-6 pr-4 font-medium">When</th>
                  <th class="py-2.5 pr-4 font-medium">Description</th>
                  <th class="py-2.5 pr-6 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {#each ledger.payouts.slice(0, 30) as p (p.sourceRef)}
                  <tr class="border-b border-border/50 last:border-0">
                    <td class="tnum whitespace-nowrap py-2.5 pl-6 pr-4 text-xs text-fg-faint">{formatDateTime(p.occurredAt)}</td>
                    <td class="max-w-[300px] truncate py-2.5 pr-4 text-fg" title={p.description ?? ""}>{p.description ?? "—"}</td>
                    <td class="tnum py-2.5 pr-6 text-right font-medium {p.amount >= 0 ? 'text-positive' : 'text-negative'}">{formatSignedMoney(p.amount)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </Panel>
    {/if}
  {/if}
</div>
