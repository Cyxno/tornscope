<script lang="ts">
  import type { ApiKeyStatusResponse, ApiKeyValidationResponse, KeyCapabilitiesDto, MeResponse } from "@tornscope/shared";
  import { branding, CAPABILITY_KEYS, FEATURE_REQUIREMENTS, capabilityLevel } from "@tornscope/shared";
  import { onMount } from "svelte";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
import NotificationsSettings from "$lib/components/NotificationsSettings.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  let status = $state<ApiKeyStatusResponse | null>(null);
  let me = $state<MeResponse | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let validatingReplace = $state(false);
  let newKey = $state("");
  let message = $state<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  let identityConflict = $state<{ existing: { name: string | null; tornId: number }; incoming: { name: string | null; tornId: number } } | null>(null);
  // Two-step replace: preview the new key's access before storing anything.
  let replacePreview = $state<ApiKeyValidationResponse | null>(null);
  let deletingProfile = $state(false);
  let signingOutOthers = $state(false);
  let matrixOpen = $state(false);

  async function load(attempt = 0): Promise<void> {
    try {
      [status, me] = await Promise.all([endpoints.apiKeyStatus(), endpoints.me()]);
      loading = false;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        await load(attempt + 1);
        return;
      }
      message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
      loading = false;
    }
  }

  // Client-only: a top-level call here would also run during SSR, where the
  // relative /api fetch fails and the retry sleeps would stall the response.
  onMount(() => {
    void load();
  });

  /** Step 1 of a replace/insert: validate WITHOUT storing, show the change. */
  async function previewSave() {
    if (newKey.trim().length < 10) return;
    validatingReplace = true;
    message = null;
    identityConflict = null;
    try {
      replacePreview = await endpoints.validateApiKey(newKey.trim());
    } catch (err) {
      message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      validatingReplace = false;
    }
  }

  /** Step 2: actually store the key (the explicit "replace stored key"). */
  async function confirmSave(confirmNewProfile = false) {
    saving = true;
    message = null;
    try {
      status = await endpoints.saveApiKey(newKey.trim(), confirmNewProfile);
      newKey = "";
      replacePreview = null;
      identityConflict = null;
      await load();
      message = { tone: "ok", text: "API key validated and stored encrypted. Sync schedules are active." };
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "identity_conflict") {
        replacePreview = null;
        identityConflict = (err.details as { existing: { name: string | null; tornId: number }; incoming: { name: string | null; tornId: number } } | null) ?? null;
        message = { tone: "err", text: err.message };
      } else {
        message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
      }
    } finally {
      saving = false;
    }
  }

  function cancelPreview() {
    replacePreview = null;
    newKey = "";
  }

  function onApiKeyError(err: unknown): void {
    message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
  }

  async function remove() {
    try {
      await endpoints.deleteApiKey();
      await load();
      message = { tone: "ok", text: "API key disconnected. Collected historical data is kept and sync stops." };
    } catch (err) {
      onApiKeyError(err);
    }
  }

  async function signOutOthers() {
    signingOutOthers = true;
    try {
      const result = await endpoints.signOutOtherSessions();
      await load();
      message = { tone: "ok", text: `Signed out ${result.revoked} other browser${result.revoked === 1 ? "" : "s"}. This browser stays signed in.` };
    } catch (err) {
      onApiKeyError(err);
    } finally {
      signingOutOthers = false;
    }
  }

  async function deleteProfile() {
    if (!deletingProfile) {
      deletingProfile = true;
      return;
    }
    try {
      await endpoints.deleteProfile();
      window.location.href = "/";
    } catch (err) {
      deletingProfile = false;
      onApiKeyError(err);
    }
  }

  const CAP_LABELS: Partial<Record<string, string>> = {
    canReadUserBasic: "Basic account access",
    canReadUserBars: "User Bars",
    canReadUserCooldowns: "User Cooldowns",
    canReadUserEducation: "User Education",
    canReadUserTravel: "User Travel",
    canReadUserMoney: "User Money",
    canReadUserLogs: "User Logs",
    canReadUserAttacks: "User Attacks",
    canReadUserNetworth: "User Networth",
    canReadUserEvents: "User Events",
    canReadUserPersonalStats: "User Personal Stats",
    canReadFactionBasic: "Faction Basic",
    canReadFactionMembers: "Faction Members",
    canReadFactionRankedWars: "Faction Ranked Wars",
    canReadFactionChains: "Faction Chains",
    canReadFactionCrimes: "Faction Crimes",
    canReadFactionArmoryNews: "Faction Armory News",
    canReadFactionBalance: "Faction Balance",
    canReadFactionLogs: "Faction Logs",
  };

  const caps = $derived((status?.capabilities ?? me?.capabilities ?? null) as KeyCapabilitiesDto | null);

  /** Rows of the feature matrix: what each TornScope feature needs and whether it works. */
  const matrixRows = $derived(
    FEATURE_REQUIREMENTS.map((f) => {
      const missing = f.requires.filter((k) => !caps || !caps[k]);
      const optionalMissing = (f.optional ?? []).filter((k) => !caps || !caps[k]);
      const available = missing.length === 0;
      const partial = available && optionalMissing.length > 0 && f.partial;
      const requirementLabel = f.requires
        .map((k) => CAP_LABELS[k] ?? k)
        .join(" + ");
      const state = !available ? "Unavailable" : partial ? "Partial" : "Available";
      return { label: f.label, requirementLabel, state, available, partial };
    })
  );

  /** Capabilities that would add something the current key lacks. */
  const missingCapabilities = $derived(caps ? CAPABILITY_KEYS.filter((k) => !caps[k]) : CAPABILITY_KEYS);

  const UNLOCK_COPY: Record<string, string> = {
    canReadUserBars: "Live bars on the Today page",
    canReadUserCooldowns: "Live cooldown timers",
    canReadUserEducation: "Education progress",
    canReadUserTravel: "Live travel status",
    canReadUserMoney: "Cash positions & bank investment",
    canReadUserLogs: "Historical travel, drug, money, crime and rehab analytics",
    canReadUserAttacks: "Combat analytics",
    canReadUserNetworth: "Net worth history",
    canReadUserEvents: "Torn events in the timeline",
    canReadUserPersonalStats: "Personal stats tracking",
    canReadFactionBasic: "Faction overview",
    canReadFactionMembers: "Faction members roster",
    canReadFactionRankedWars: "Ranked war history",
    canReadFactionChains: "Faction chain history",
    canReadFactionCrimes: "Organized crime history",
    canReadFactionArmoryNews: "Faction armory provenance (sponsored Xanax detection)",
    canReadFactionBalance: "Faction balance tracking",
    canReadFactionLogs: "Faction log analytics",
  };
</script>

<svelte:head><title>Settings · TornScope</title></svelte:head>

<div class="space-y-10">
  <PageHeader
    eyebrow="System"
    title="Settings"
    description="Your connection to Torn — encrypted at rest, never exposed to the browser again after submission."
  />

  {#if message}
    <div class="rounded-xl border px-4 py-2.5 text-[13px] {message.tone === 'ok' ? 'border-positive/25 bg-positive/5 text-positive' : message.tone === 'warn' ? 'border-warning/25 bg-warning/5 text-warning' : 'border-negative/25 bg-negative/5 text-negative'}">
      {message.text}
    </div>
  {/if}

  <Panel title="Torn API key" caption="Validated against Torn, encrypted with AES-256-GCM, decrypted only for outgoing requests">
    {#if loading}
      <StateMessage state="loading" />
    {:else if status?.hasKey}
      <dl class="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-3">
        <div>
          <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Key</dt>
          <dd class="tnum mt-1 text-fg">{status.keyPreview}</dd>
        </div>
        <div>
          <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">API access</dt>
          <dd class="mt-1 text-fg">
            {status.accessType ?? "Unknown"}{status.accessLevel ? ` · level ${status.accessLevel}` : ""}
            {#if caps}
              <span class="ml-1 text-fg-faint">({capabilityLevel(caps)})</span>
            {/if}
          </dd>
        </div>
        <div>
          <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Player</dt>
          <dd class="mt-1 text-fg">{status.tornName ? `${status.tornName} [${status.tornId}]` : "—"}</dd>
        </div>
        <div>
          <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Validated</dt>
          <dd class="mt-1 text-fg-muted">{formatRelative(status.validatedAt)}</dd>
        </div>
        <div>
          <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Log access</dt>
          <dd class="mt-1 text-fg-muted">{status.logAccessAvailable ? "Available" : "Unavailable"}</dd>
        </div>
        <div>
          <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Active browser sessions</dt>
          <dd class="mt-1 text-fg-muted">
            {me?.activeSessions ?? 1}
            {#if (me?.activeSessions ?? 1) > 1}
              <button class="ml-2 text-xs text-fg-muted underline decoration-border underline-offset-2 transition-colors hover:text-accent disabled:opacity-40" disabled={signingOutOthers} onclick={() => void signOutOthers()}>
                {signingOutOthers ? "Signing out…" : "Sign out other browsers"}
              </button>
            {/if}
          </dd>
        </div>
      </dl>
      <div class="mt-6 flex items-center gap-3 border-t border-border pt-5">
        <span class="text-xs text-fg-faint">Stop syncing without losing collected history:</span>
        <button class="rounded-full border border-negative/30 px-4 py-1.5 text-xs font-medium text-negative transition-colors hover:bg-negative/10" onclick={() => void remove()}>
          Disconnect API key
        </button>
      </div>
    {:else}
      <p class="text-[13px] text-fg-muted">No API key stored yet. The welcome flow sets this up — or add one below.</p>
    {/if}

    <div class="mt-6 border-t border-border pt-6">
      <label class="mb-2.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint" for="new-key">
        {status?.hasKey ? "Replace key" : "Add a key"}
      </label>

      {#if !replacePreview}
        <div class="flex max-w-xl flex-wrap gap-2.5">
          <input
            id="new-key"
            type="password"
            bind:value={newKey}
            placeholder="Paste your Torn API key"
            autocomplete="off"
            class="min-w-0 flex-1 rounded-xl border border-border bg-bg-raise px-4 py-2.5 font-mono text-sm text-fg placeholder:font-sans placeholder:text-fg-faint focus:border-accent"
          />
          <button class="rounded-xl bg-accent-strong px-5 text-sm font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40" disabled={validatingReplace || saving || newKey.trim().length < 10} onclick={() => void previewSave()}>
            {validatingReplace ? "Validating…" : "Validate"}
          </button>
        </div>
        {#if identityConflict}
          <div class="mt-4 rounded-xl border border-warning/30 bg-warning/5 p-4">
            <p class="text-[13px] font-medium text-warning">Different Torn account detected</p>
            <p class="mt-1 text-xs text-fg-muted">
              This profile is linked to <span class="font-medium text-fg">{identityConflict.existing.name ?? "player"} [{identityConflict.existing.tornId}]</span>.
              The new key belongs to <span class="font-medium text-fg">{identityConflict.incoming.name ?? "player"} [{identityConflict.incoming.tornId}]</span>.
              The two histories are never merged.
            </p>
            <div class="mt-3 flex flex-wrap gap-2.5">
              <button class="rounded-full border border-warning/40 px-4 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/10" onclick={() => void confirmSave(true)}>
                Start new profile/data context
              </button>
              <button class="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg" onclick={() => (identityConflict = null)}>
                Cancel
              </button>
            </div>
          </div>
        {/if}
        <p class="mt-2.5 text-xs text-fg-faint">
          TornScope also works with limited permissions — more access unlocks additional analytics. The key is validated via /key/info before anything is stored.
        </p>
      {:else}
        <!-- Replace preview: explicit two-step flow, nothing stored yet -->
        <div class="max-w-xl space-y-4 rounded-xl border border-border bg-bg-raise p-5">
          <div class="flex items-center justify-between">
            <p class="text-[13px] font-semibold text-fg">Key validated — nothing stored yet</p>
            <span class="text-xs text-fg-muted">{replacePreview.accessType ?? "Unknown access"}{replacePreview.accessLevel !== null ? ` · level ${replacePreview.accessLevel}` : ""}</span>
          </div>

          {#if replacePreview.capabilityChange && (replacePreview.capabilityChange.newlyUnavailable.length > 0 || replacePreview.capabilityChange.newlyAvailable.length > 0)}
            <div class="space-y-1.5 text-[13px]">
              {#if replacePreview.capabilityChange.newlyUnavailable.length > 0}
                <p class="text-warning">
                  Losing: {replacePreview.capabilityChange.newlyUnavailable.map((k) => CAP_LABELS[k] ?? k).join(", ")}
                </p>
              {/if}
              {#if replacePreview.capabilityChange.newlyAvailable.length > 0}
                <p class="text-positive">
                  Gaining: {replacePreview.capabilityChange.newlyAvailable.map((k) => CAP_LABELS[k] ?? k).join(", ")}
                </p>
              {/if}
            </div>
          {/if}

          {#if replacePreview.downgrade}
            <p class="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-warning">
              Replacing this key reduces available permissions. Some TornScope analytics may stop refreshing.
              Previously collected history is never deleted — it stays available and is marked as no longer refreshing.
            </p>
          {:else if replacePreview.upgrade}
            <p class="rounded-lg border border-positive/25 bg-positive/5 px-3 py-2 text-xs leading-relaxed text-positive">
              The new key unlocks additional analytics. Existing history is preserved.
            </p>
          {/if}

          {#if replacePreview.tornId !== null && status?.tornId !== null && replacePreview.tornId !== status?.tornId}
            <p class="text-xs text-warning">
              This key belongs to a different Torn player ({replacePreview.tornName ?? replacePreview.tornId}) than the one on this profile
              ({status?.tornName ?? status?.tornId}). Saving will offer to start a new profile instead of merging.
            </p>
          {/if}

          <div class="flex flex-wrap gap-2.5">
            <button class="rounded-xl bg-accent-strong px-5 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40" disabled={saving} onclick={() => void confirmSave()}>
              {saving ? "Storing…" : status?.hasKey ? "Replace stored key" : "Store key"}
            </button>
            <button class="rounded-xl border border-border px-4 py-2 text-sm text-fg-muted transition-colors hover:text-fg" onclick={cancelPreview}>
              Cancel
            </button>
          </div>
        </div>
      {/if}
    </div>
  </Panel>

  <Panel
    title="Feature access"
    caption={caps ? `Derived from your key's actual permissions (${status?.accessType ?? "detected"}) — never from a manually chosen level` : "Connect a key to see what it can power"}>
    {#if loading}
      <StateMessage state="loading" />
    {:else if caps}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-[13px]">
          <thead>
            <tr class="border-b border-border text-[11px] uppercase tracking-[0.14em] text-fg-faint">
              <th class="py-2 pr-4 font-medium">Feature</th>
              <th class="py-2 pr-4 font-medium">Requires</th>
              <th class="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {#each matrixRows as row (row.label)}
              <tr class="border-b border-border/50 last:border-0">
                <td class="py-2 pr-4 text-fg">{row.label}</td>
                <td class="py-2 pr-4 text-fg-muted">{row.requirementLabel}</td>
                <td class="py-2">
                  <span class={row.available ? (row.partial ? "text-warning" : "text-positive") : "text-fg-faint"}>
                    {row.state}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <details class="mt-5 border-t border-border pt-4">
        <summary class="cursor-pointer text-[13px] font-medium text-fg-muted transition-colors hover:text-accent">
          What does additional API access unlock?
        </summary>
        <ul class="mt-3 max-w-2xl space-y-1 text-[13px] text-fg-muted">
          {#each missingCapabilities as key (key)}
            {#if UNLOCK_COPY[key]}
              <li>· <span class="text-fg">{CAP_LABELS[key]}</span> — {UNLOCK_COPY[key]}</li>
            {/if}
          {/each}
          {#if missingCapabilities.length === 0}
            <li>Your key already grants every capability TornScope can use.</li>
          {/if}
        </ul>
        <p class="mt-3 text-xs text-fg-faint">
          Torn API keys are read-only. Broader permissions expose more private Torn data — including detailed
          activity and log history. A limited key is a valid privacy choice; TornScope shows exactly what it
          can and cannot see.
        </p>
      </details>
    {:else}
      <StateMessage
        state="permission"
        title="No API key connected"
        hint="Connect a Torn API key to enable analytics. Limited permissions work too — each feature below lists exactly what it needs."
      />
    {/if}
  </Panel>

  <Panel title="Privacy & security" caption="What TornScope stores, and where">
    <ul class="max-w-2xl space-y-1.5 text-[13px] leading-relaxed text-fg-muted">
      <li>• Your Torn API key is stored <span class="text-fg">encrypted server-side</span> (AES-256-GCM) and is never sent back to the browser.</li>
      <li>• Your browser stores only an <span class="text-fg">opaque session identifier</span> — never the API key.</li>
      <li>• Personal analytics are isolated per browser profile; other visitors cannot read your data.</li>
      <li>• Torn API keys are read-only and cannot perform in-game actions. Broader permissions can expose more private Torn data — including detailed activity/log history — so choosing a limited key reduces exposure.</li>
      <li>• Connecting your key from a new browser links that browser to your existing profile; the stored key is never replaced silently and history is never imported twice.</li>
      <li>• Disconnecting the key stops all Torn syncing; collected history is kept unless you delete it.</li>
      <li>• Deleting this TornScope profile removes that profile's stored data permanently.</li>
      <li>• Clearing this site's cookies detaches the browser from its profile; a valid API key for the same Torn account can link this browser to the existing profile again.</li>
    </ul>
  </Panel>

  <Panel title="Notifications" caption="TornScope alerts on this device — timers, Torn attention events, OC">
    <NotificationsSettings />
  </Panel>

  <Panel title="Display defaults" caption="Timezone, currency and price basis used across TornScope">
    <dl class="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-3">
      <div>
        <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Timezone</dt>
        <dd class="mt-1 text-fg">UTC</dd>
      </div>
      <div>
        <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Currency</dt>
        <dd class="mt-1 text-fg">Torn dollars ($)</dd>
      </div>
      <div>
        <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Market prices</dt>
        <dd class="mt-1 text-fg">Torn item catalog (estimated)</dd>
      </div>
    </dl>
  </Panel>

  <Panel title="Delete this TornScope profile" caption="Destructive and irreversible — different from disconnecting">
    <p class="max-w-2xl text-[13px] leading-relaxed text-fg-muted">
      Removes the TornScope profile linked to this browser: the encrypted API key, sync state, settings and all personal
      analytics collected for it. Other profiles are never affected. Other browsers linked to the same profile must
      disconnect separately.
    </p>
    <div class="mt-4 flex items-center gap-3">
      <button
        class="rounded-full border px-4 py-1.5 text-xs font-medium transition-colors {deletingProfile ? 'border-negative bg-negative text-bg font-semibold' : 'border-negative/30 text-negative hover:bg-negative/10'}"
        onclick={() => void deleteProfile()}
      >
        {deletingProfile ? "Click again to permanently delete" : "Delete this TornScope profile"}
      </button>
      {#if deletingProfile}
        <button class="text-xs text-fg-faint hover:text-fg" onclick={() => (deletingProfile = false)}>cancel</button>
      {/if}
    </div>
  </Panel>

  <Panel title="Your data" caption="What happens when you disconnect">
    <p class="max-w-2xl text-[13px] leading-relaxed text-fg-muted">
      Your historical TornScope data remains stored on the TornScope server when you disconnect your API key.
      Syncing simply pauses; reconnecting the same Torn identity continues building on the history you already have.
    </p>
  </Panel>

  <Panel title="About TornScope" caption="Release status, maintainer and independence">
    <dl class="grid grid-cols-1 gap-x-8 gap-y-5 md:grid-cols-3">
      <div>
        <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Status</dt>
        <dd class="mt-1">
          <span class="inline-flex items-center gap-2 text-fg">
            Public Beta
            <span class="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-accent">Beta</span>
          </span>
        </dd>
      </div>
      <div>
        <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Release</dt>
        <dd class="tnum mt-1 text-fg">{branding.publicVersion}</dd>
      </div>
      <div>
        <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Maintainer</dt>
        <dd class="mt-1 text-fg">
          <a
            href="https://www.torn.com/profiles.php?XID=1816206"
            target="_blank"
            rel="noopener noreferrer"
            class="underline decoration-border underline-offset-2 transition-colors hover:text-accent hover:decoration-accent"
          >Cyxno on Torn</a>
        </dd>
      </div>
    </dl>
    <div class="mt-5 max-w-2xl space-y-2 border-t border-border pt-4 text-[13px] leading-relaxed text-fg-muted">
      <p>
        TornScope is in public beta: historical tracking and analytics are actively being refined, and updates
        may occasionally include fixes and database migrations. Collected history is kept across updates — if you
        self-host this instance, keep your own backups as well.
      </p>
      <p>
        Found a bug or rough edge, need help, or interested in a private TornScope Docker deployment?
        <a
          href="https://www.torn.com/profiles.php?XID=1816206"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent underline decoration-border underline-offset-2 transition-colors hover:decoration-accent"
        >Contact Cyxno on Torn</a>.
      </p>
      <p class="text-[12px] text-fg-faint">
        TornScope is an independent community project — not operated, endorsed, or hosted by Torn.
      </p>
    </div>
  </Panel>
</div>
