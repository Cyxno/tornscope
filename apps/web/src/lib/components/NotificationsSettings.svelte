<script lang="ts">
  import { onMount } from "svelte";
  import { env as publicEnv } from "$env/dynamic/public";
  import type { NotificationsStatusResponse, NotificationHistoryResponse } from "@tornscope/shared";
  import { CAPABILITY_LABELS, DELIVERY_REASON_LABELS, DELIVERY_STATUSES, NOTIFICATION_GROUPS, NOTIFICATION_TYPES, type DeliveryReason, type DeliveryStatus } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { me } from "$lib/state.svelte";
  import { formatRelative } from "$lib/reltime";
  import * as td from "$lib/time-display.svelte.js";
  import StateMessage from "./StateMessage.svelte";
  import { detectPushCapability, type PushCapability } from "$lib/pwa";
  import { browserPush, enablePush, enablePushFailureText } from "$lib/push";

  /**
   * Notification settings — the user-control surface for the canonical type
   * registry (packages/shared/src/notifications.ts). Grouped per-type
   * toggles with inline thresholds, quiet hours with an honest deferral
   * policy, device management, a real test push, and the delivery history
   * ledger that explains what fired — and what didn't, and why.
   */

  let status = $state<NotificationsStatusResponse | null>(null);
  let history = $state<NotificationHistoryResponse | null>(null);
  type PushEnv = PushCapability;
  let support = $state<PushEnv>({ kind: "unsupported" });
  let iosEnv = $state(false);
  let standaloneEnv = $state(false);
  let permission = $state<NotificationPermission | "default">("default");
  let swRegistration = $state<ServiceWorkerRegistration | null>(null);
  let busy = $state(false);
  let testing = $state(false);
  let notice = $state<{ tone: "ok" | "err"; text: string } | null>(null);
  let currentEndpoint = $state<string | null>(null);

  const caps = $derived(me.data?.capabilities ?? null);
  const canToggle = $derived(me.data?.isDemo !== true);
  const timezone = $derived(me.data?.timezone ?? "UTC");
  // Operator-configured browser-facing origin (PUBLIC_BASE_URL), offered on
  // insecure contexts ONLY when it is a valid HTTPS address — the product
  // never assumes a domain. Empty when unset (e.g. pure localhost setups).
  const configuredPublicAddress = $derived.by(() => {
    const value = typeof publicEnv.PUBLIC_BASE_URL === "string" ? publicEnv.PUBLIC_BASE_URL.trim() : "";
    return /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(value) ? value : "";
  });

  function capabilityBlocked(requires: string | null): boolean {
    if (!requires) return false;
    const value = (caps as Record<string, boolean> | null)?.[requires as keyof typeof caps];
    return value === false;
  }

  function detectSupport(): void {
    if (typeof window === "undefined") return;
    const detected = detectPushCapability();
    support = detected.capability;
    iosEnv = detected.ios;
    standaloneEnv = detected.standalone;
    permission = support.kind === "ok" ? support.permission : "default";
  }

  // VAPID key decoding and the enable pipeline live in $lib/push (tested
  // there): the server's key is base64URL and must be normalized before
  // atob() — see the regression note in that module.

  async function refresh(): Promise<void> {
    try {
      status = await endpoints.notificationsStatus(currentEndpoint ?? undefined);
    } catch {
      status = null;
    }
    if (me.data?.isDemo) {
      history = await endpoints.notificationsHistory().catch(() => null);
    } else {
      history = await endpoints.notificationsHistory().catch(() => null);
    }
  }

  async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
    if (swRegistration) return swRegistration;
    const reg = await navigator.serviceWorker.register("/sw.js");
    swRegistration = reg;
    return reg;
  }

  async function currentSubscription(): Promise<PushSubscription | null> {
    const reg = await ensureServiceWorker();
    return (await reg.pushManager.getSubscription()) ?? null;
  }

  async function enable(): Promise<void> {
    busy = true;
    notice = null;
    const outcome = await enablePush(browserPush(), {
      vapidPublicKey: () => endpoints.notificationsVapidPublicKey().then((res) => res.publicKey),
      registerSubscription: (subscription) => endpoints.notificationsSubscribe(subscription).then(() => undefined),
    });
    // Re-read live state: the permission prompt may have changed it, and the
    // header guidance keys off `permission === "denied"`.
    detectSupport();
    if (outcome.ok) {
      currentEndpoint = outcome.endpoint;
      notice = { tone: "ok", text: "Notifications enabled on this device." };
      await refresh();
    } else {
      notice = { tone: "err", text: enablePushFailureText(outcome.kind) };
    }
    busy = false;
  }

  // Server-authored messages (ApiClientError) are fine to surface; anything
  // else is a raw browser exception and must never reach the user verbatim.
  function pushFailureText(err: unknown): string {
    return err instanceof ApiClientError ? err.message : enablePushFailureText("unknown");
  }

  async function disableThisDevice(): Promise<void> {
    if (!currentEndpoint) return;
    busy = true;
    try {
      await endpoints.notificationsUnsubscribe(currentEndpoint);
      const sub = await currentSubscription();
      await sub?.unsubscribe().catch(() => undefined);
      notice = { tone: "ok", text: "Notifications disabled on this device." };
      await refresh();
    } catch (err) {
      notice = { tone: "err", text: pushFailureText(err) };
    } finally {
      busy = false;
    }
  }

  async function disableDevice(id: string): Promise<void> {
    await endpoints.notificationsDisableDevice(id).catch(() => undefined);
    await refresh();
  }

  async function sendTest(): Promise<void> {
    if (!currentEndpoint) return;
    testing = true;
    notice = null;
    try {
      const result = await endpoints.notificationsTest(currentEndpoint);
      notice = result.sent
        ? { tone: "ok", text: "Test notification sent — check this device." }
        : { tone: "err", text: "The notification could not be delivered." };
      await refresh();
    } catch (err) {
      notice = { tone: "err", text: pushFailureText(err) };
    } finally {
      testing = false;
    }
  }

  async function toggleType(id: string, value: boolean): Promise<void> {
    if (!status) return;
    const categories = { ...status.preferences.categories, [id]: value };
    try {
      const prefs = await endpoints.notificationsUpdatePreferences({ categories });
      if (status) status = { ...status, preferences: prefs };
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    }
  }

  async function setConfig(key: string, value: number): Promise<void> {
    if (!status) return;
    try {
      const prefs = await endpoints.notificationsUpdatePreferences({ typeConfig: { [key]: value } });
      if (status) status = { ...status, preferences: prefs };
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    }
  }

  async function toggleSensitive(value: boolean): Promise<void> {
    if (!status) return;
    try {
      const prefs = await endpoints.notificationsUpdatePreferences({ sensitiveDetails: value });
      if (status) status = { ...status, preferences: prefs };
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    }
  }

  async function setQuietHours(start: number | null, end: number | null): Promise<void> {
    if (!status) return;
    try {
      const prefs = await endpoints.notificationsUpdatePreferences({ quietStartMin: start, quietEndMin: end });
      if (status) status = { ...status, preferences: prefs };
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    }
  }

  async function setBypassCritical(value: boolean): Promise<void> {
    if (!status) return;
    try {
      const prefs = await endpoints.notificationsUpdatePreferences({ bypassCritical: value });
      if (status) status = { ...status, preferences: prefs };
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    }
  }

  const DELIVERY_STATUS_LABELS: Record<string, string> = {
    sent: "sent",
    pending: "pending",
    failed: "failed",
    invalid_subscription: "subscription expired",
    suppressed: "suppressed",
  };

  function humanizeStatus(status: string): string {
    return status.replaceAll("_", " ");
  }

  function minutesToTime(min: number): string {
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  }

  onMount(async () => {
    detectSupport();
    if (support.kind === "ok") {
      try {
        const reg = await ensureServiceWorker();
        const sub = await reg.pushManager.getSubscription();
        if (sub) currentEndpoint = sub.endpoint;
      } catch (err) {
        // An honest registration failure beats a generic unsupported claim.
        support = { kind: "sw-failed", reason: err instanceof Error ? err.message : "registration failed" };
      }
    }
    await refresh();
  });
  /**
   * section: which slice renders. "full" (default) = everything (legacy
   * single-panel usage); "preferences" = alerts/quiet hours/history for the
   * Notifications tab; "devices" = device registration + device list for the
   * Devices tab.
   */
  let { section = "full" }: { section?: "full" | "preferences" | "devices" } = $props();
  // $derived keeps these reactive if a caller ever toggles sections dynamically.
  const showPreferences = $derived(section === "full" || section === "preferences");
  const showDevices = $derived(section === "full" || section === "devices");
</script>

<div class="space-y-4">
  <div class="flex items-start gap-4">
    <img src="/icons/tornscope-notifications-192.png" alt="" aria-hidden="true" class="h-16 w-16 shrink-0 rounded-xl" />
    <div class="min-w-0 text-[13px] leading-relaxed text-fg-muted">
      <p>
        {#if support.kind === "ios-needs-install"}
          <span class="font-medium text-warning">On iPhone, install TornScope on your Home Screen first to enable notifications.</span>
          Open TornScope in Safari, tap <span class="font-medium text-fg">Share</span> (the square with the arrow
          pointing out), choose <span class="font-medium text-fg">Add to Home Screen</span>, then open TornScope
          from the Home Screen icon and enable notifications here. Web Push on iOS only works from the installed
          app — not from a browser tab (this includes Firefox and Chrome on iOS, which use Apple's web engine).
        {:else if support.kind === "unsupported"}
          Push notifications are not supported {#if iosEnv}for this iOS version — the Home Screen app needs iOS 16.4 or newer for Web Push{:else}in this browser{/if}.
        {:else if support.kind === "insecure"}
          <span class="font-medium text-warning">Push notifications require HTTPS.</span>
          Open TornScope through an HTTPS address to enable notifications — browsers only
          expose push in secure contexts. (localhost is a valid development exception.)
          {#if configuredPublicAddress}
            <span class="mt-1 block">
              This server's configured public address is
              <a class="underline decoration-border underline-offset-2 hover:text-fg" href={configuredPublicAddress}>{configuredPublicAddress}</a>.
            </span>
          {/if}
        {:else if support.kind === "sw-failed"}
          <span class="font-medium text-warning">The notification service worker could not be registered.</span>
          {support.reason}
        {:else if status && !status.pushConfigured}
          Push is not configured on this server yet.
        {:else if status && status.devices.some((d) => d.current)}
          Push notifications: <span class="font-medium text-positive">enabled on this device</span>.
        {:else if permission === "denied"}
          Notifications are blocked in this browser. Enable them in your browser/site settings to use TornScope alerts.
        {:else}
          Push notifications: <span class="font-medium text-fg">not enabled on this device</span>.
        {/if}
      </p>
      <p class="mt-1 text-xs text-fg-faint">
        Every alert below fires on a state change — never repeatedly while a condition holds — and is
        delivered to every enabled device exactly once.
      </p>
    </div>
  </div>

  {#if notice}
    <div class="rounded-xl border px-4 py-2.5 text-[13px] {notice.tone === 'ok' ? 'border-positive/25 bg-positive/5 text-positive' : 'border-negative/25 bg-negative/5 text-negative'}">
      {notice.text}
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-3">
    {#if support.kind === "ok" && status?.pushConfigured}
      <!-- supported + not enabled / enabled are handled inside -->
      {#if status.devices.some((d) => d.current)}
        <button
          class="rounded-full border border-negative/30 px-4 py-1.5 text-xs font-medium text-negative transition-colors hover:bg-negative/10 disabled:opacity-40"
          disabled={busy}
          onclick={() => void disableThisDevice()}
        >
          Disable on this device
        </button>
        <button
          class="btn btn-sm"
          disabled={testing}
          onclick={() => void sendTest()}
        >
          {testing ? "Sending…" : "Send test notification"}
        </button>
      {:else}
        <button
          class="rounded-full bg-accent-strong px-4 py-1.5 text-xs font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40"
          disabled={busy || canToggle === false}
          onclick={() => void enable()}
        >
          {busy ? "Enabling…" : "Enable notifications"}
        </button>
      {/if}
    {/if}
    {#if me.data?.isDemo}
      <p class="text-xs text-fg-faint">Demo profiles don't generate real alerts — enable push on your own profile.</p>
    {/if}
  </div>

  {#if showDevices && status && status.devices.length > 0}
    <div>
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Registered devices</p>
      <ul class="space-y-1 text-xs text-fg-muted">
        {#each status.devices as device (device.id)}
          <li class="flex items-center justify-between gap-3">
            <span class="min-w-0 truncate">
              {#if device.current}<span class="font-medium text-fg">This browser</span>{:else}{device.label ?? device.userAgent?.slice(0, 40) ?? "Device"}{/if}
              <span class="text-fg-faint" title={td.alternateTimeTooltip(device.createdAt)}>· since {td.displayDate(device.createdAt)}</span>
              {#if device.lastSeenAt}
                <span class="text-fg-faint" title={td.alternateTimeTooltip(device.lastSeenAt)}>· last seen {formatRelative(device.lastSeenAt)}</span>
              {/if}
            </span>
            {#if !device.current}
              <button class="shrink-0 text-fg-faint underline decoration-border underline-offset-2 transition-colors hover:text-negative" onclick={() => void disableDevice(device.id)}>
                Disable
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if showPreferences && status}
    <details class="rounded-xl border border-border bg-bg-raise px-4 py-3" open>
      <summary class="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint transition-colors hover:text-fg-muted">
        Alert types
      </summary>

      <!-- Quiet hours -->
      <div class="mt-3 space-y-2 text-[13px]">
        <p class="font-medium text-fg">
          Quiet hours
          <span class="ml-1 text-xs font-normal text-fg-faint" title={`Quiet hours follow your profile timezone (${timezone}), not this device's clock.`}>({timezone})</span>
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <input
            type="time"
            aria-label="Quiet hours start"
            class="rounded-lg border border-border bg-bg-raise px-2 py-1 text-xs text-fg"
            value={status.preferences.quietStartMin !== null ? minutesToTime(status.preferences.quietStartMin) : ""}
            onchange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (!v) return void setQuietHours(null, null);
              const [h, m] = v.split(":").map(Number);
              // Read the sibling input's live value — the other field may have
              // been edited since the last save (status is stale mid-race).
              const endVal = (document.querySelector('input[aria-label="Quiet hours end"]') as HTMLInputElement | null)?.value;
              const [eh, em] = endVal ? endVal.split(":").map(Number) : [];
              void setQuietHours(h! * 60 + m!, eh !== undefined ? eh! * 60 + (em ?? 0) : status!.preferences.quietEndMin ?? 420);
            }}
          />
          <span class="text-fg-faint">→</span>
          <input
            type="time"
            aria-label="Quiet hours end"
            class="rounded-lg border border-border bg-bg-raise px-2 py-1 text-xs text-fg"
            value={status.preferences.quietEndMin !== null ? minutesToTime(status.preferences.quietEndMin) : ""}
            onchange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (!v) return void setQuietHours(null, null);
              const [h, m] = v.split(":").map(Number);
              const startVal = (document.querySelector('input[aria-label="Quiet hours start"]') as HTMLInputElement | null)?.value;
              const [sh, sm] = startVal ? startVal.split(":").map(Number) : [];
              void setQuietHours(sh !== undefined ? sh! * 60 + (sm ?? 0) : status!.preferences.quietStartMin ?? 1380, h! * 60 + m!);
            }}
          />
          {#if status.preferences.quietStartMin !== null}
            <button class="text-xs text-fg-faint hover:text-fg" onclick={() => void setQuietHours(null, null)}>clear</button>
          {/if}
        </div>
        <p class="text-xs text-fg-faint">
          While quiet hours are active, alerts wait and are delivered when they end. Deferred alerts that are
          no longer useful by then (an "energy full" from the night before) are skipped instead of delivered stale.
        </p>
        <label class="flex items-center justify-between gap-3 pt-1">
          <span class="text-fg-muted">
            Critical system alerts during quiet hours
            <span class="block text-xs text-fg-faint">Only TornScope's own "access lost" alert qualifies — never game events.</span>
          </span>
          <input
            type="checkbox"
            checked={status.preferences.bypassCritical}
            onchange={(e) => void setBypassCritical((e.currentTarget as HTMLInputElement).checked)}
            class="h-4 w-4 accent-teal-400"
          />
        </label>
      </div>

      <!-- Grouped type toggles -->
      {#each NOTIFICATION_GROUPS as group (group.id)}
        <div class="mt-4 border-t border-border pt-3">
          <p class="text-[11px] font-semibold uppercase tracking-[0.12em] text-fg-muted">{group.label}</p>
          <p class="text-xs text-fg-faint">{group.description}</p>
          <div class="mt-2 grid gap-x-6 gap-y-2 text-[13px] lg:grid-cols-2">
            {#each NOTIFICATION_TYPES.filter((t) => t.group === group.id) as t (t.id)}
              {@const blocked = capabilityBlocked(t.requires)}
              <div class="flex items-start justify-between gap-3 py-0.5" class:opacity-50={blocked}>
                <div class="min-w-0">
                  <span class="text-fg-muted">{t.label}</span>
                  <span class="block text-xs text-fg-faint">
                    {#if blocked}
                      Unavailable — your API key lacks {t.requires ? CAPABILITY_LABELS[t.requires as keyof typeof CAPABILITY_LABELS]?.label ?? "a required permission" : "a required permission"}
                    {:else}
                      {t.description}
                    {/if}
                  </span>
                  {#if !blocked && t.config.length > 0 && status.preferences.categories[t.id]}
                    <span class="mt-1 flex flex-wrap items-center gap-2">
                      {#if t.config.includes("nearFullThreshold")}
                        <label class="flex items-center gap-1 text-xs text-fg-faint">
                          Threshold
                          <input
                            type="number" min="1" max="1000"
                            class="w-20 rounded-lg border border-border bg-bg-raise px-2 py-0.5 text-xs text-fg"
                            value={status.preferences.typeConfig.nearFullThreshold}
                            onchange={(e) => void setConfig("nearFullThreshold", Number((e.currentTarget as HTMLInputElement).value) || 135)}
                          />
                        </label>
                      {/if}
                      {#if t.config.includes("cashThreshold")}
                        <label class="flex items-center gap-1 text-xs text-fg-faint">
                          Min $
                          <input
                            type="number" min="0" step="1_000_000"
                            class="w-28 rounded-lg border border-border bg-bg-raise px-2 py-0.5 text-xs text-fg"
                            value={status.preferences.typeConfig.cashThreshold}
                            onchange={(e) => void setConfig("cashThreshold", Number((e.currentTarget as HTMLInputElement).value) || 50000000)}
                          />
                        </label>
                      {/if}
                      {#if t.config.includes("networthThreshold")}
                        <label class="flex items-center gap-1 text-xs text-fg-faint">
                          Min Δ $
                          <input
                            type="number" min="0" step="1_000_000"
                            class="w-28 rounded-lg border border-border bg-bg-raise px-2 py-0.5 text-xs text-fg"
                            value={status.preferences.typeConfig.networthThreshold}
                            onchange={(e) => void setConfig("networthThreshold", Number((e.currentTarget as HTMLInputElement).value) || 100000000)}
                          />
                        </label>
                      {/if}
                      {#if t.config.includes("summaryTimeMin")}
                        <label class="flex items-center gap-1 text-xs text-fg-faint">
                          At
                          <input
                            type="time"
                            class="rounded-lg border border-border bg-bg-raise px-2 py-0.5 text-xs text-fg"
                            title={`Profile timezone (${timezone})`}
                            value={minutesToTime(status.preferences.typeConfig.summaryTimeMin)}
                            onchange={(e) => {
                              const v = (e.currentTarget as HTMLInputElement).value;
                              if (!v) return;
                              const [h, m] = v.split(":").map(Number);
                              void setConfig("summaryTimeMin", h! * 60 + m!);
                            }}
                          />
                        </label>
                      {/if}
                    </span>
                  {/if}
                </div>
                <input
                  type="checkbox"
                  aria-label="{t.label} notifications"
                  checked={status.preferences.categories[t.id] ?? t.defaultEnabled}
                  disabled={blocked}
                  onchange={(e) => void toggleType(t.id, (e.currentTarget as HTMLInputElement).checked)}
                  class="mt-1 h-4 w-4 shrink-0 accent-teal-400"
                />
              </div>
            {/each}
          </div>
        </div>
      {/each}

      <div class="mt-4 space-y-2 border-t border-border pt-3 text-[13px]">
        <label class="flex items-center justify-between gap-3">
          <span class="text-fg-muted" title="Include amounts, senders and item names in notification bodies. Notifications may be visible on lock screens.">
            Show sensitive details in notifications
          </span>
          <input
            type="checkbox"
            checked={status.preferences.sensitiveDetails}
            onchange={(e) => void toggleSensitive((e.currentTarget as HTMLInputElement).checked)}
            class="h-4 w-4 accent-teal-400"
          />
        </label>
        <p class="text-xs text-fg-faint">Default off — notifications stay generic on lock screens.</p>
      </div>
    </details>
  {/if}

  <!-- Delivery history -->
  {#if showPreferences && history && history.entries.length > 0}
    <div>
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Recent deliveries</p>
      <ul class="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {#each history.entries.slice(0, 12) as entry (entry.id)}
          <li class="bg-surface px-4 py-2.5 text-[13px]">
            <details>
              <summary class="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 select-none">
                <span class="font-mono text-xs text-fg-faint">{td.displayTime(entry.occurredAt)}</span>
                <span class="min-w-0 flex-1 truncate text-fg">{entry.title}</span>
                <span class="text-xs {entry.status === 'delivered' || entry.status === 'sent' ? 'text-positive' : entry.status === 'failed' || entry.status === 'expired' ? 'text-negative' : 'text-fg-faint'}">
                  {entry.status}
                  {#if entry.reason}
                    · {DELIVERY_REASON_LABELS[entry.reason as DeliveryReason] ?? entry.reason}
                  {/if}
                </span>
              </summary>
              <div class="mt-2 space-y-1 text-xs text-fg-faint">
                <p>{entry.body}</p>
                <!-- Full datetime in the display zone; the tooltip carries the
                     alternate zone so the fired-at moment is unambiguous. -->
                <p title={td.alternateTimeTooltip(entry.occurredAt)}>Fact provenance: {entry.provenance}. Fired at {td.displayDateTime(entry.occurredAt)}.</p>
                {#each entry.deliveries as d (d.device ?? "")}
                  <p>
                    → {d.device ?? "Device"}: {d.status.includes("_") ? DELIVERY_STATUS_LABELS[d.status as DeliveryStatus] ?? humanizeStatus(d.status) : d.status}{d.reason ? ` (${DELIVERY_REASON_LABELS[d.reason as DeliveryReason] ?? d.reason})` : ""}{d.sentAt ? ` · ${td.displayTime(d.sentAt)}` : ""}{d.attempts > 1 ? ` · ${d.attempts} attempts` : ""}
                  </p>
                {/each}
              </div>
            </details>
          </li>
        {/each}
      </ul>
      <p class="mt-1.5 text-xs text-fg-faint">Delivery history is kept for 90 days.</p>
    </div>
  {:else if history}
    <StateMessage state="empty" compact title="No deliveries yet" hint="Alerts you receive (or that are deferred or skipped) appear here with the reason." />
  {/if}
</div>
