<script lang="ts">
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import Panel from "$lib/components/Panel.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import type { AlertChannelDto } from "@tornscope/shared";

  /**
   * Discord channels. Webhook URLs are SECRETS: the input is type=password,
   * the stored target only ever appears as the server-masked preview, and
   * delivery errors are sanitized server-side before they render here.
   */

  let channels = $state<AlertChannelDto[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<{ tone: "ok" | "err"; text: string } | null>(null);
  let url = $state("");
  let busy = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await endpoints.alertsChannels();
      channels = res.channels;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function addChannel(): Promise<void> {
    const trimmed = url.trim();
    if (trimmed === "") {
      notice = { tone: "err", text: "Paste a Discord webhook URL first." };
      return;
    }
    busy = "add";
    try {
      await endpoints.alertsCreateChannel({ type: "discord", url: trimmed });
      url = "";
      notice = { tone: "ok", text: "Channel added. Send a test to verify it." };
      await load();
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      busy = null;
    }
  }

  async function toggleChannel(channel: AlertChannelDto, enabled: boolean): Promise<void> {
    busy = channel.id;
    try {
      await endpoints.alertsUpdateChannel(channel.id, { enabled });
      await load();
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      busy = null;
    }
  }

  async function testChannel(channel: AlertChannelDto): Promise<void> {
    busy = `test-${channel.id}`;
    try {
      const result = await endpoints.alertsTestChannel(channel.id);
      if (result.ok) {
        notice = { tone: "ok", text: "Test delivered — check your Discord channel." };
      } else {
        notice = { tone: "err", text: `Test failed: ${result.message ?? result.errorKind ?? "unknown error"}` };
      }
      await load();
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      busy = null;
    }
  }

  async function removeChannel(channel: AlertChannelDto): Promise<void> {
    if (!window.confirm("Remove this Discord channel? Pending deliveries for it stop retrying.")) return;
    busy = channel.id;
    try {
      await endpoints.alertsDeleteChannel(channel.id);
      notice = { tone: "ok", text: "Channel removed." };
      await load();
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      busy = null;
    }
  }

  $effect(() => {
    void load();
  });
</script>

{#if notice}
  <div
    class="mb-4 rounded-tile border px-4 py-2.5 text-[13px] {notice.tone === 'ok'
      ? 'border-positive/25 bg-positive/5 text-fg'
      : 'border-negative/30 bg-negative/5 text-negative'}"
    role="status"
  >
    {notice.text}
    <button class="ml-2 underline decoration-border underline-offset-2 hover:text-fg-muted" onclick={() => (notice = null)}>Dismiss</button>
  </div>
{/if}

<Panel title="Add a Discord webhook" caption="Server settings → Integrations → Webhooks → New webhook. The URL is stored encrypted and never shown again.">
  <form
    class="flex flex-col gap-3 sm:flex-row"
    onsubmit={(e) => {
      e.preventDefault();
      void addChannel();
    }}
  >
    <input
      type="password"
      class="input flex-1"
      placeholder="https://discord.com/api/webhooks/…"
      autocomplete="off"
      bind:value={url}
      aria-label="Discord webhook URL"
    />
    <button type="submit" class="btn btn-primary shrink-0" disabled={busy === "add"}>
      {busy === "add" ? "Adding…" : "Add channel"}
    </button>
  </form>
</Panel>

<div class="mt-4 space-y-2.5">
  {#if loading}
    <StateMessage state="loading" title="Loading channels" skeleton="rows" />
  {:else if error}
    <StateMessage state="error" title="Could not load channels" hint={error} action={{ label: "Retry", run: () => void load() }} />
  {:else if channels.length === 0}
    <StateMessage state="empty" title="No Discord channels yet" hint="Add a webhook above to receive alerts in Discord. In-app alerts always arrive in the Inbox." />
  {:else}
    {#each channels as channel (channel.id)}
      <Panel variant="quiet">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-3">
            <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-tile bg-surface-2 text-fg-muted">
              <Icon name="bell" size={16} />
            </span>
            <div class="min-w-0">
              <p class="truncate font-mono text-[12.5px] text-fg">{channel.targetPreview}</p>
              <p class="text-[11.5px] text-fg-faint">
                Discord
                {#if channel.verifiedAtSec !== null}
                  · <span class="text-positive">verified</span> {formatRelative(channel.verifiedAtSec)}
                {:else}
                  · <span class="text-warning">not verified</span>
                {/if}
                · {channel.enabled ? "enabled" : "disabled"}
              </p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <label class="flex items-center gap-2 text-[12px] text-fg-muted">
              <input
                type="checkbox"
                class="h-4 w-4 accent-teal-400"
                checked={channel.enabled}
                disabled={busy === channel.id}
                onchange={(e) => void toggleChannel(channel, (e.currentTarget as HTMLInputElement).checked)}
              />
              Enabled
            </label>
            <button class="btn btn-sm" disabled={busy !== null} onclick={() => void testChannel(channel)}>
              {busy === `test-${channel.id}` ? "Testing…" : "Send test"}
            </button>
            <button class="btn btn-sm btn-danger" disabled={busy !== null} onclick={() => void removeChannel(channel)}>
              Remove
            </button>
          </div>
        </div>
      </Panel>
    {/each}
  {/if}
</div>
