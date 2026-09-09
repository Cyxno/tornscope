<script lang="ts">
  import { onMount } from "svelte";
  import { env as publicEnv } from "$env/dynamic/public";
  import type { NotificationsStatusResponse } from "@tornscope/shared";
  import { NOTIFICATION_CATEGORIES } from "@tornscope/shared";
  import { endpoints, ApiClientError } from "$lib/api";
  import { me } from "$lib/state.svelte";
  import StateMessage from "./StateMessage.svelte";

  /**
   * Push notification settings (per browser/device + per-profile prefs).
   * Browser support, permission state and VAPID configuration are detected;
   * unsupported browsers get a graceful note instead of a broken panel.
   */

  let status = $state<NotificationsStatusResponse | null>(null);
  type PushEnv =
    | { kind: "unsupported" }
    | { kind: "insecure" }
    | { kind: "sw-failed"; reason: string }
    | { kind: "ok"; permission: NotificationPermission };
  let support = $state<PushEnv>({ kind: "unsupported" });
  let permission = $state<NotificationPermission | "default">("default");
  let swRegistration = $state<ServiceWorkerRegistration | null>(null);
  let busy = $state(false);
  let testing = $state(false);
  let notice = $state<{ tone: "ok" | "err"; text: string } | null>(null);
  let currentEndpoint = $state<string | null>(null);

  const caps = $derived(me.data?.capabilities ?? null);
  const canToggle = $derived(me.data?.isDemo !== true);
  // Operator-configured browser-facing origin (PUBLIC_BASE_URL), offered on
  // insecure contexts ONLY when it is a valid HTTPS address — the product
  // never assumes a domain. Empty when unset (e.g. pure localhost setups).
  const configuredPublicAddress = $derived.by(() => {
    const value = typeof publicEnv.PUBLIC_BASE_URL === "string" ? publicEnv.PUBLIC_BASE_URL.trim() : "";
    return /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(value) ? value : "";
  });

  function detectSupport(): void {
    if (typeof window === "undefined") return;
    // Web Push (service workers) requires a SECURE CONTEXT: HTTPS, or
    // localhost as a development exception. A LAN IP over plain HTTP is NOT
    // secure — Firefox/Chrome will not expose PushManager there. Collapsing
    // that into "unsupported" used to mislead Firefox users.
    // Secure-context FIRST: on an insecure origin (LAN HTTP) Firefox does
    // not expose PushManager/Notification at all, so capability checks
    // would misreport a working browser as "unsupported".
    if (!window.isSecureContext) {
      support = { kind: "insecure" };
      permission = "default";
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      support = { kind: "unsupported" };
      return;
    }
    support = { kind: "ok", permission: Notification.permission };
    permission = Notification.permission;
  }

  function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const buffer = new ArrayBuffer(raw.length);
    const output = new Uint8Array(buffer);
    for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  async function refresh(): Promise<void> {
    try {
      status = await endpoints.notificationsStatus(currentEndpoint ?? undefined);
    } catch {
      status = null;
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
    try {
      const keyRes = await endpoints.notificationsVapidPublicKey();
      if (!keyRes.publicKey) {
        notice = { tone: "err", text: "Push is not configured on this server yet." };
        return;
      }
      if (Notification.permission !== "granted") {
        const requested = await Notification.requestPermission();
        permission = requested;
        support = { kind: "ok", permission: requested };
        if (requested !== "granted") {
          notice = { tone: "err", text: "Browser permission was not granted." };
          return;
        }
      }
      const reg = await ensureServiceWorker();
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyRes.publicKey),
        }));
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        notice = { tone: "err", text: "The browser returned an incomplete subscription." };
        return;
      }
      currentEndpoint = json.endpoint;
      await endpoints.notificationsSubscribe({ endpoint: json.endpoint, keys: json.keys as { p256dh: string; auth: string } });
      notice = { tone: "ok", text: "Notifications enabled on this device." };
      await refresh();
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      busy = false;
    }
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
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
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
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      testing = false;
    }
  }

  async function toggleCategory(id: string, value: boolean): Promise<void> {
    if (!status) return;
    const categories = { ...status.preferences.categories, [id]: value };
    try {
      const prefs = await endpoints.notificationsUpdatePreferences({ categories });
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

  onMount(async () => {
    detectSupport();
    if (support.kind === "unsupported" || support.kind === "insecure") return;
    try {
      const reg = await ensureServiceWorker();
      const sub = await reg.pushManager.getSubscription();
      if (sub) currentEndpoint = sub.endpoint;
    } catch {
      // SW registration issues surface through the enable flow.
    }
    await refresh();
  });
</script>

<div class="space-y-4">
  <div class="flex items-start gap-4">
    <img src="/icons/tornscope-notifications-192.png" alt="" aria-hidden="true" class="h-16 w-16 shrink-0 rounded-xl" />
    <div class="min-w-0 text-[13px] leading-relaxed text-fg-muted">
      <p>
        {#if support.kind === "unsupported"}
          Push notifications are not supported in this browser.
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
        Push notification subscriptions are stored by the TornScope server so it can send alerts to this device.
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

  {#if status && status.devices.length > 0}
    <div>
      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Devices</p>
      <ul class="space-y-1 text-xs text-fg-muted">
        {#each status.devices as device (device.id)}
          <li class="flex items-center justify-between gap-3">
            <span class="min-w-0 truncate">
              {#if device.current}<span class="font-medium text-fg">This browser</span>{:else}{device.userAgent?.slice(0, 60) ?? "Device"}{/if}
              <span class="text-fg-faint">· since {new Date(device.createdAt * 1000).toLocaleDateString("en-US")}</span>
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

  {#if status}
    <details class="rounded-xl border border-border bg-bg-raise px-4 py-3">
      <summary class="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint transition-colors hover:text-fg-muted">
        Notification categories
      </summary>
      <div class="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
        {#each NOTIFICATION_CATEGORIES as category (category.id)}
          {@const capabilityOk = !caps || caps[category.requires as keyof typeof caps] !== false || caps[category.requires as keyof typeof caps] === undefined}
          <label class="flex items-center justify-between gap-3" class:opacity-50={!capabilityOk}>
            <span class="text-fg-muted">
              {category.label}
              {#if !capabilityOk}
                <span class="text-[10px] uppercase tracking-wide text-fg-faint">Unavailable with current API permissions</span>
              {/if}
            </span>
            <input
              type="checkbox"
              checked={status.preferences.categories[category.id] ?? category.default}
              disabled={!capabilityOk}
              onchange={(e) => void toggleCategory(category.id, (e.currentTarget as HTMLInputElement).checked)}
              class="h-4 w-4 accent-teal-400"
            />
          </label>
        {/each}
      </div>

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

      <div class="mt-4 space-y-2 border-t border-border pt-3 text-[13px]">
        <p class="text-fg-muted">Quiet hours <span class="text-xs text-fg-faint">(non-critical alerts are held)</span></p>
        <div class="flex flex-wrap items-center gap-2">
          <input
            type="time"
            class="rounded-lg border border-border bg-bg-raise px-2 py-1 text-xs text-fg"
            value={status.preferences.quietStartMin !== null
              ? `${String(Math.floor(status.preferences.quietStartMin / 60)).padStart(2, "0")}:${String(status.preferences.quietStartMin % 60).padStart(2, "0")}`
              : ""}
            onchange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (!v) return void setQuietHours(null, null);
              const [h, m] = v.split(":").map(Number);
              void setQuietHours(h! * 60 + m!, status!.preferences.quietEndMin ?? 420);
            }}
          />
          <span class="text-fg-faint">–</span>
          <input
            type="time"
            class="rounded-lg border border-border bg-bg-raise px-2 py-1 text-xs text-fg"
            value={status.preferences.quietEndMin !== null
              ? `${String(Math.floor(status.preferences.quietEndMin / 60)).padStart(2, "0")}:${String(status.preferences.quietEndMin % 60).padStart(2, "0")}`
              : ""}
            onchange={(e) => {
              const v = (e.currentTarget as HTMLInputElement).value;
              if (!v) return void setQuietHours(null, null);
              const [h, m] = v.split(":").map(Number);
              void setQuietHours(status!.preferences.quietStartMin ?? 1380, h! * 60 + m!);
            }}
          />
          {#if status.preferences.quietStartMin !== null}
            <button class="text-xs text-fg-faint hover:text-fg" onclick={() => void setQuietHours(null, null)}>clear</button>
          {/if}
        </div>
      </div>
    </details>
  {/if}
</div>
