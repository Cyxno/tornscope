<script lang="ts">
  import type { ApiKeyStatusResponse } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import Panel from "$lib/components/Panel.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";

  let status = $state<ApiKeyStatusResponse | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let newKey = $state("");
  let message = $state<{ tone: "ok" | "err"; text: string } | null>(null);

  async function load() {
    try {
      status = await endpoints.apiKeyStatus();
    } catch (err) {
      message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      loading = false;
    }
  }

  void load();

  async function save() {
    saving = true;
    message = null;
    try {
      status = await endpoints.saveApiKey(newKey.trim());
      newKey = "";
      message = { tone: "ok", text: "API key validated and stored encrypted. Sync schedules are active." };
    } catch (err) {
      message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      saving = false;
    }
  }

  async function remove() {
    try {
      await endpoints.deleteApiKey();
      await load();
      message = { tone: "ok", text: "API key deleted. Collected historical data is kept." };
    } catch (err) {
      message = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
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
        <span class="text-xs text-fg-faint">Remove the key without losing collected history:</span>
        <button class="rounded-full border border-negative/30 px-4 py-1.5 text-xs font-medium text-negative transition-colors hover:bg-negative/10" onclick={() => void remove()}>
          Delete API key
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
      <p class="mt-2.5 text-xs text-fg-faint">
        Full Access keys unlock log-based analytics (drugs, money, travel). The key is validated via /key/info before anything is stored.
      </p>
    </div>
  </Panel>

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

  <Panel title="Data & backups" caption="Your history may be unrecoverable from Torn later">
    <p class="max-w-2xl text-[13px] leading-relaxed text-fg-muted">
      All historical data lives in the PostgreSQL volume on your Unraid server. Schedule regular dumps so the history
      you build survives disk trouble:
    </p>
    <pre class="mt-3 overflow-x-auto rounded-xl border border-border bg-bg-raise px-4 py-3 font-mono text-xs text-fg-muted">docker compose -f docker-compose.unraid.yml exec postgres pg_dump -U tornscope tornscope | gzip &gt; tornscope-backup.sql.gz</pre>
  </Panel>
</div>
