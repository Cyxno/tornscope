<script lang="ts">
  import type { ApiKeyStatusResponse, KeyCapabilitiesDto, MeResponse } from "@tornscope/shared";
  import { capabilityLevel } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  let status = $state<ApiKeyStatusResponse | null>(null);
  let me = $state<MeResponse | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let newKey = $state("");
  let message = $state<{ tone: "ok" | "err"; text: string } | null>(null);
  let identityConflict = $state<{ existing: { name: string | null; tornId: number }; incoming: { name: string | null; tornId: number } } | null>(null);
  let bindToken = $state("");
  let deletingProfile = $state(false);

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

  void load();

  async function save(confirmNewProfile = false) {
    saving = true;
    message = null;
    try {
      status = await endpoints.saveApiKey(newKey.trim(), confirmNewProfile);
      newKey = "";
      identityConflict = null;
      await load();
      message = { tone: "ok", text: "API key validated and stored encrypted. Sync schedules are active." };
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "identity_conflict") {
        identityConflict = (err.details as { existing: { name: string | null; tornId: number }; incoming: { name: string | null; tornId: number } } | null) ?? null;
        message = { tone: "err", text: err.message };
      } else {
        message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
      }
    } finally {
      saving = false;
    }
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

  async function bindOwner() {
    try {
      me = await endpoints.bindOwner(bindToken.trim());
      bindToken = "";
      await load();
      message = { tone: "ok", text: "Legacy owner profile bound to this browser." };
    } catch (err) {
      onApiKeyError(err);
    }
  }
</script>

<div class="space-y-10">
  <PageHeader
    eyebrow="System"
    title="Settings"
    description="Your connection to Torn — encrypted at rest, never exposed to the browser again after submission."
  />

  {#if message}
    <div class="rounded-xl border px-4 py-2.5 text-[13px] {message.tone === 'ok' ? 'border-positive/25 bg-positive/5 text-positive' : 'border-negative/25 bg-negative/5 text-negative'}">
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
          <dt class="text-[11px] font-medium uppercase tracking-[0.14em] text-fg-faint">Access level</dt>
          <dd class="mt-1 text-fg">{status.accessType ?? "unknown"}{status.accessLevel ? ` (lvl ${status.accessLevel})` : ""}</dd>
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
      <div class="flex max-w-xl gap-2.5">
        <input
          id="new-key"
          type="password"
          bind:value={newKey}
          placeholder="Paste a Torn API key with Full Access"
          autocomplete="off"
          class="flex-1 rounded-xl border border-border bg-bg-raise px-4 py-2.5 font-mono text-sm text-fg placeholder:font-sans placeholder:text-fg-faint focus:border-accent"
        />
        <button class="rounded-xl bg-accent-strong px-5 text-sm font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40" disabled={saving || newKey.trim().length < 10} onclick={() => void save()}>
          {saving ? "Validating…" : "Save"}
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
            <button class="rounded-full border border-warning/40 px-4 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/10" onclick={() => void save(true)}>
              Start new profile/data context
            </button>
            <button class="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg" onclick={() => (identityConflict = null)}>
              Cancel
            </button>
          </div>
        </div>
      {/if}
      <p class="mt-2.5 text-xs text-fg-faint">
        Full Access keys unlock log-based analytics (drugs, money, travel). The key is validated via /key/info before anything is stored.
      </p>
    </div>
  </Panel>

  {#if status?.capabilities}
    {@const caps = status.capabilities}
    <Panel
      title="Detected access"
      caption={status.capabilities
        ? `${capabilityLevel(status.capabilities)} — read from your key's actual permissions, modules appear only when your key can answer them`
        : "Read from your key's actual permissions"}>
      <div class="grid gap-6 md:grid-cols-2">
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-positive">Available</p>
          <ul class="mt-2 space-y-1.5 text-[13px] text-fg-muted">
            {#if caps.canReadUserBasic}<li>Account basics — profile, level, faction</li>{/if}
            {#if caps.canReadUserBars}<li>Live bars & cooldowns — Today page</li>{/if}
            {#if caps.canReadUserMoney}<li>Cash positions & bank investment — Wallet, Today</li>{/if}
            {#if caps.canReadUserNetworth}<li>Net worth snapshots — wealth history</li>{/if}
            {#if caps.canReadUserLogs}<li>Personal logs — drugs, money, travel, rehab history</li>{/if}
            {#if caps.canReadUserAttacks}<li>Attacks — combat analytics</li>{/if}
            {#if caps.canReadFactionBasic}<li>Faction basics</li>{/if}
            {#if caps.canReadFactionMembers}<li>Faction members roster</li>{/if}
            {#if caps.canReadFactionRankedWars}<li>Faction ranked wars</li>{/if}
            {#if caps.canReadFactionCrimes}<li>Faction organized crimes</li>{/if}
            {#if caps.canReadFactionArmoryNews}<li>Faction armory news — sponsored-drug detection</li>{/if}
            {#if caps.canReadFactionBalance}<li>Faction balance</li>{/if}
            {#if caps.canReadFactionLogs}<li>Faction logs</li>{/if}
          </ul>
        </div>
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Unavailable</p>
          <ul class="mt-2 space-y-1.5 text-[13px] text-fg-faint">
            {#if !caps.canReadUserBasic}<li>Account basics (needs Public access or higher)</li>{/if}
            {#if !caps.canReadUserBars}<li>Live bars & cooldowns</li>{/if}
            {#if !caps.canReadUserMoney}<li>Cash positions & bank investment</li>{/if}
            {#if !caps.canReadUserNetworth}<li>Net worth snapshots</li>{/if}
            {#if !caps.canReadUserLogs}<li>Personal logs — historical analytics stay unavailable rather than partial</li>{/if}
            {#if !caps.canReadUserAttacks}<li>Attacks — combat analytics</li>{/if}
            {#if !caps.canReadFactionBasic}<li>Faction analytics (needs a key with faction access)</li>{/if}
            {#if !caps.canReadFactionMembers}<li>Faction members roster</li>{/if}
            {#if !caps.canReadFactionRankedWars}<li>Faction ranked wars</li>{/if}
            {#if !caps.canReadFactionCrimes}<li>Faction organized crimes</li>{/if}
            {#if !caps.canReadFactionArmoryNews}<li>Faction armory news — funded-drug detection stays Unknown</li>{/if}
            {#if !caps.canReadFactionBalance}<li>Faction balance</li>{/if}
            {#if !caps.canReadFactionLogs}<li>Faction logs</li>{/if}
          </ul>
        </div>
      </div>
      <p class="mt-4 border-t border-border pt-3 text-xs text-fg-faint">
        Broader API permissions unlock richer analytics — add only what you are comfortable sharing with your own server.
        Modules degrade honestly: unavailable sources show Unknown or a clear explanation, never fabricated numbers.
      </p>
    </Panel>
  {/if}

  <Panel title="Privacy & security" caption="What TornScope stores, and where">
    <ul class="max-w-2xl space-y-1.5 text-[13px] leading-relaxed text-fg-muted">
      <li>• Your Torn API key is stored <span class="text-fg">encrypted server-side</span> (AES-256-GCM) and is never sent back to the browser.</li>
      <li>• Your browser stores only an <span class="text-fg">opaque session identifier</span> — never the API key.</li>
      <li>• Personal analytics are isolated per browser profile; other visitors cannot read your data.</li>
      <li>• Disconnecting the key stops all Torn syncing; collected history is kept unless you delete it.</li>
      <li>• Deleting this TornScope profile removes that profile's stored data permanently.</li>
      <li>• Clearing this site's cookies detaches the browser from its profile (no recovery in V1).</li>
    </ul>
  </Panel>

  {#if me?.ownerBindAvailable}
    <Panel title="Legacy owner binding" caption="One-time recovery: attach the existing owner dataset to this browser (works even after the first bind)">
      <div class="flex max-w-xl gap-2.5">
        <input
          type="password"
          bind:value={bindToken}
          placeholder="Paste the owner binding token (OWNER_BIND_TOKEN)"
          autocomplete="off"
          class="flex-1 rounded-xl border border-border bg-bg-raise px-4 py-2.5 font-mono text-sm text-fg placeholder:font-sans placeholder:text-fg-faint focus:border-accent"
        />
        <button class="rounded-xl bg-accent-strong px-5 text-sm font-semibold text-bg transition-colors hover:bg-accent" onclick={() => void bindOwner()}>
          Bind owner
        </button>
      </div>
      <p class="mt-2.5 text-xs text-fg-faint">One-time binding: after it succeeds, the token stops working for everyone.</p>
    </Panel>
  {/if}

  <Panel title="Display defaults" caption="Per-user preferences arrive with multi-user support">
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
      Removes this browser's profile: the encrypted API key, sync state, settings and all personal analytics collected
      for it. Other profiles are never affected. Collected history is kept unless you explicitly delete the profile here.
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

  <Panel title="Data & backups" caption="Your history may be unrecoverable from Torn later">
    <p class="max-w-2xl text-[13px] leading-relaxed text-fg-muted">
      All historical data lives in the PostgreSQL volume on your Unraid server. Schedule regular dumps so the history
      you build survives disk trouble:
    </p>
    <pre class="mt-3 overflow-x-auto rounded-xl border border-border bg-bg-raise px-4 py-3 font-mono text-xs text-fg-muted">docker compose -f docker-compose.unraid.yml exec postgres pg_dump -U tornscope tornscope | gzip &gt; tornscope-backup.sql.gz</pre>
  </Panel>
</div>
