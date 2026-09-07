<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { endpoints, ApiClientError } from "$lib/api";
  import type { ApiKeyStatusResponse, ApiKeyValidationResponse, ExistingProfileInfo, KeyCapabilitiesDto, SyncResource } from "@tornscope/shared";
  import { branding, CAPABILITY_LABELS, moduleAvailability, resourceRequirementLabel, summarizeKeyAccess } from "@tornscope/shared";
  import { refreshMe, me } from "$lib/state.svelte";

  let apiKey = $state("");
  let validating = $state(false);
  let saving = $state(false);
  let loadingDemo = $state(false);
  let error = $state<string | null>(null);
  let status = $state<ApiKeyStatusResponse | null>(null);
  // 1 = key form · 2 = detected access · 3 = existing-profile link ·
  // 4 = import progress · 5 = generic saving spinner
  let step = $state(1);

  // Detected access (step 2) — validated live against Torn WITHOUT storing
  // anything, so the access summary is shown BEFORE the first sync starts.
  let detected = $state<ApiKeyValidationResponse | null>(null);
  let storedKey = $state(""); // kept in memory only until used or cleared

  // Existing-profile reuse (Phase: profile reuse / multi-device linking).
  // Set when the backend answers a key save with `profile_exists`.
  let existing = $state<{
    profile: ExistingProfileInfo;
    incoming: { accessLevel: number | null; accessType: string | null; capabilities: KeyCapabilitiesDto | null };
    downgrade: boolean;
  } | null>(null);
  let linking = $state(false);
  let replacing = $state(false);

  // Step 4 progress (resource-level — never an invented overall percentage).
  type ResourceRow = { resource: string; status: string; lastSuccessAt: number | null; recordsCollected: number; errorMessage: string | null };
  let syncRows = $state<ResourceRow[]>([]);
  let syncRunning = $state(false);
  let retrying = $state(false);

  const RESOURCE_LABELS: Record<string, string> = {
    profile: "Profile",
    networth: "Net worth",
    personal_stats: "Live stats",
    drugs: "Drug history",
    rehab: "Rehab",
    money_logs: "Economy",
    travel: "Travel",
    events: "Events",
    faction_basic: "Faction",
    faction: "Faction detail",
    ranked_wars: "Ranked wars",
    chains: "Chains",
    organized_crimes: "Organized crimes",
    attacks: "Combat",
    torn_catalog: "Catalog",
  };

  /** Step 1: validate against Torn without storing anything. */
  async function validateKey() {
    if (apiKey.trim().length < 10) {
      error = "That doesn't look like a valid Torn API key.";
      return;
    }
    validating = true;
    error = null;
    storedKey = apiKey.trim();
    try {
      detected = await endpoints.validateApiKey(storedKey);
      apiKey = "";
      step = 2;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      validating = false;
    }
  }

  /** Step 2 → 4: store the validated key; the backend queues the initial
   * backfill itself (capability-aware — resources the key cannot answer are
   * never run). */
  async function startTracking() {
    if (!detected) return;
    saving = true;
    error = null;
    try {
      status = await endpoints.saveApiKey(storedKey);
      storedKey = "";
      detected = null;
      await refreshMe(); // drop stale "not configured" state immediately
      step = 4;
      void pollSync();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "profile_exists") {
        const details = (err.details ?? {}) as {
          existing?: ExistingProfileInfo;
          incoming?: { accessLevel: number | null; accessType: string | null; capabilities: KeyCapabilitiesDto | null };
          downgrade?: boolean;
        };
        if (details.existing) {
          existing = {
            profile: details.existing,
            incoming: details.incoming ?? { accessLevel: null, accessType: null, capabilities: null },
            downgrade: details.downgrade === true,
          };
          step = 3;
        } else {
          error = err.message;
        }
      } else {
        error = err instanceof ApiClientError ? err.message : (err as Error).message;
      }
    } finally {
      saving = false;
    }
  }

  /** Primary action: bind this browser to the existing profile. The stored
   * API key of that profile is NOT touched and nothing re-imports. */
  async function useExistingProfile() {
    if (!existing) return;
    linking = true;
    error = null;
    try {
      await endpoints.linkProfile(storedKey);
      storedKey = "";
      existing = null;
      await refreshMe();
      status = await endpoints.apiKeyStatus();
      step = 4;
      void pollSync();
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      linking = false;
    }
  }

  /** Optional separate action: link AND replace the stored key with this one.
   * Explicit — linking alone never does this. */
  async function replaceStoredKey() {
    if (!existing) return;
    replacing = true;
    error = null;
    try {
      await endpoints.linkProfile(storedKey);
      await endpoints.saveApiKey(storedKey);
      storedKey = "";
      existing = null;
      await refreshMe();
      status = await endpoints.apiKeyStatus();
      step = 4;
      void pollSync();
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      replacing = false;
    }
  }

  function cancelLink() {
    existing = null;
    storedKey = "";
    step = 1;
  }

  function backToKeyForm() {
    detected = null;
    storedKey = "";
    step = 1;
  }

  async function pollSync() {
    try {
      const s = await endpoints.syncStatus();
      syncRunning = s.running;
      syncRows = s.resources as ResourceRow[];
    } catch {
      // Progress is best-effort; the button below never depends on it.
    }
  }

  function rowState(row: ResourceRow): { label: string; cls: string; skipped: boolean } {
    if (row.status === "running") return { label: row.lastSuccessAt === null ? "importing" : "syncing", cls: "text-accent", skipped: false };
    // Capability-blocked: this key can never fetch this resource. Not an
    // error, not a zero — an explicit skip with the missing permission named.
    if (row.status === "capability_denied") {
      return { label: `Skipped — ${resourceRequirementLabel(row.resource as SyncResource)} permission unavailable`, cls: "text-fg-faint", skipped: true };
    }
    if (row.errorMessage && row.lastSuccessAt === null) return { label: "failed", cls: "text-negative", skipped: false };
    if (row.lastSuccessAt !== null) {
      return { label: row.recordsCollected > 0 ? `ready · ${row.recordsCollected.toLocaleString("en-US")} records` : "ready", cls: "text-positive", skipped: false };
    }
    return { label: "waiting", cls: "text-fg-faint", skipped: false };
  }

  async function retryFailed() {
    retrying = true;
    try {
      await endpoints.syncRetryFailed();
      void pollSync();
    } catch {
      // surfaced on the Sync Status page
    } finally {
      retrying = false;
    }
  }

  async function exploreDemo() {
    loadingDemo = true;
    error = null;
    try {
      await endpoints.setDemoView(true);
      await refreshMe();
      await goto("/today");
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
      loadingDemo = false;
    }
  }

  function openApp() {
    void goto("/today");
  }

  const accessSummary = $derived(
    detected ? summarizeKeyAccess(detected.capabilities, detected.accessLevel, detected.accessType) : null
  );
  const limitedAccess = $derived(accessSummary !== null && accessSummary.levelName !== "Full");

  /** Human-readable per-capability list for the "exactly what this key allows" disclosure. */
  function capabilityList(caps: KeyCapabilitiesDto): Array<{ label: string; granted: boolean }> {
    return (Object.keys(CAPABILITY_LABELS) as Array<keyof typeof CAPABILITY_LABELS>)
      .filter((key) => key in caps)
      .map((key) => ({ label: CAPABILITY_LABELS[key]!.label, granted: Boolean((caps as Record<string, unknown>)[key]) }));
  }

  const caps = $derived(me.data?.capabilities ?? null);
  const modules = $derived(moduleAvailability(caps ?? {
    canReadUserBasic: false, canReadUserBars: false, canReadUserCooldowns: false, canReadUserEducation: false,
    canReadUserTravel: false, canReadUserMoney: false, canReadUserLogs: false, canReadUserAttacks: false,
    canReadUserNetworth: false, canReadUserEvents: false, canReadUserPersonalStats: false,
    canReadFactionBasic: false, canReadFactionMembers: false, canReadFactionRankedWars: false,
    canReadFactionChains: false, canReadFactionCrimes: false, canReadFactionArmoryNews: false,
    canReadFactionBalance: false, canReadFactionLogs: false,
  }));
  const availableModules = $derived(modules.filter((m) => m.available));
  const unavailableModules = $derived(modules.filter((m) => !m.available));

  onMount(() => {
    const poll = setInterval(() => {
      if (step === 4) void pollSync();
    }, 3000);
    return () => clearInterval(poll);
  });
</script>

<div class="flex min-h-screen items-center justify-center px-5 py-14">
  <div class="w-full max-w-xl space-y-10">
    <div class="space-y-3 text-center">
      <a href="/" class="inline-flex items-center gap-2.5">
        <span class="h-2 w-2 rounded-full bg-accent shadow-glow"></span>
        <span class="text-[15px] font-semibold tracking-tight text-fg">TornScope</span>
      </a>
      <h1 class="font-display text-5xl font-medium leading-tight text-fg">
        A private record of<br />your <span class="italic text-accent">Torn life</span>.
      </h1>
      <p class="mx-auto max-w-md text-sm leading-relaxed text-fg-muted">
        {branding.tagline} — continuously collected, normalized and stored on your own server, from the very first sync onward.
      </p>
    </div>

    <div class="rounded-2xl border border-border bg-surface p-7 shadow-panel">
      {#if step === 1}
        <label class="mb-2.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint" for="api-key">Connect Torn API key</label>
        <input
          id="api-key"
          type="password"
          bind:value={apiKey}
          placeholder="Paste your Torn API key"
          class="w-full rounded-xl border border-border bg-bg-raise px-4 py-3 font-mono text-sm text-fg placeholder:font-sans placeholder:text-fg-faint focus:border-accent"
          autocomplete="off"
        />
        {#if error}
          <p class="mt-2.5 text-sm text-negative">{error}</p>
        {/if}
        <button
          class="mt-5 w-full rounded-xl bg-accent-strong py-3 text-sm font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40"
          disabled={validating}
          onclick={() => void validateKey()}
        >
          {validating ? "Validating with Torn…" : "Validate key"}
        </button>
        <p class="mt-3 text-center text-xs text-fg-faint">
          TornScope also works with limited permissions. More access unlocks additional analytics.
          Get your key at <span class="font-mono text-fg-muted">torn.com/preferences.php#tab=api</span>
        </p>

        <div class="my-6 flex items-center gap-4">
          <span class="h-px flex-1 bg-border"></span>
          <span class="text-[10px] uppercase tracking-[0.18em] text-fg-faint">or</span>
          <span class="h-px flex-1 bg-border"></span>
        </div>

        <button
          class="w-full rounded-xl border border-border-strong py-3 text-sm font-medium text-fg-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
          disabled={loadingDemo}
          onclick={() => void exploreDemo()}
        >
          {loadingDemo ? "Preparing demo…" : "Explore with demo data first"}
        </button>
        {#if !error}
          <p class="mt-3 text-center text-xs text-fg-faint">Seeded example player, clearly marked — switch to your own data whenever you're ready.</p>
        {/if}

        <!-- Privacy & key choice — shown BEFORE any key is entered or validated -->
        <div class="mt-6 space-y-4 rounded-xl border border-border bg-bg-raise px-4 py-4 text-left text-[12px] leading-relaxed text-fg-muted">
          <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Limited or Full — your choice, explained</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <p class="font-semibold text-fg">
                Limited Access
                <span class="ml-1 rounded-full border border-positive/30 bg-positive/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-positive">privacy-first</span>
              </p>
              <p class="mt-1">Recommended if you prefer to share less Torn data. A valid choice — TornScope works fully with it, showing clearly-marked gaps instead of zeros.</p>
              <p class="mt-1.5 text-fg-faint"><span class="text-fg-muted">Can provide:</span> basic profile &amp; current state, live bars/cooldowns, stats and net-worth snapshots, combat history where Torn allows it.</p>
              <p class="mt-1 text-fg-faint"><span class="text-fg-muted">May not provide:</span> detailed personal logs, historical flight/economy/drug reconstruction, complete timeline.</p>
            </div>
            <div>
              <p class="font-semibold text-fg">
                Full Access
                <span class="ml-1 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-fg-faint">optional</span>
              </p>
              <p class="mt-1">Optional — unlocks TornScope's richest analytics: detailed user logs (money, drug, travel and crime history), events, and faction data where granted.</p>
              <p class="mt-1.5 text-fg-faint">Full Access can expose considerably more private Torn activity to TornScope, including detailed logs. Only use it if you trust the server running TornScope and want the additional analytics.</p>
            </div>
          </div>

          <details class="group">
            <summary class="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint transition-colors hover:text-fg-muted">
              Who can see my data? · the honest trust model
            </summary>
            <ul class="mt-2 space-y-1.5">
              <li>• TornScope runs on a server that is <span class="text-fg">independent from Torn</span>. It is not hosted or operated by Torn itself.</li>
              <li>• Your API key is stored encrypted (AES-256-GCM) and is never sent back to your browser. Torn keys are read-only: they cannot perform in-game actions.</li>
              <li>• The server must decrypt your API key whenever TornScope contacts Torn on your behalf. This means <span class="text-fg">the person operating this TornScope server can technically access the data your key permits</span>.</li>
              <li>• This server is operated by <a href="https://www.torn.com/profiles.php?XID=1816206" target="_blank" rel="noopener noreferrer" class="text-accent underline decoration-border underline-offset-2 transition-colors hover:decoration-accent">Cyxno</a>. Torn does not endorse, host or operate TornScope.</li>
              <li>• If you prefer to share less, choose a Limited key — it genuinely limits what any TornScope server can collect about you.</li>
            </ul>
          </details>

          <details class="group">
            <summary class="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint transition-colors hover:text-fg-muted">
              What does TornScope store?
            </summary>
            <ul class="mt-2 space-y-1.5">
              <li>• Your Torn API credential, <span class="text-fg">encrypted at rest</span> — decrypted only for outgoing Torn requests, never returned to the browser.</li>
              <li>• Normalized analytics collected from Torn: events, history and snapshots your key permits.</li>
              <li>• An opaque browser session identifier (never the API key) and your profile/display settings.</li>
              <li>• Disconnecting the key stops all future sync; <span class="text-fg">already-collected history is kept</span> unless you explicitly delete the profile.</li>
            </ul>
          </details>

          <p class="border-t border-border pt-3 text-[11px] text-fg-faint">
            Self-hosting TornScope yourself gives you the strongest control over your data.
          </p>
        </div>

        <div class="mt-6 space-y-2 border-t border-border pt-4 text-center text-[11px] leading-relaxed text-fg-faint">
          <p>
            No account needed: this browser gets its own anonymous TornScope profile.
            Clearing this site's cookies detaches the profile; signing in again with the same API key restores access.
          </p>
        </div>
      {:else if step === 2 && detected && accessSummary}
        <!-- Detected access: shown BEFORE anything is stored or synced -->
        <div class="space-y-5">
          <div class="space-y-1 text-center">
            <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-faint">Detected key</p>
            <p class="font-display text-2xl font-medium text-fg">{accessSummary.levelName} Access</p>
            <p class="text-xs text-fg-muted">
              Privacy: <span class={limitedAccess ? "text-positive" : "text-warning"}>{limitedAccess ? "Reduced data exposure" : "Broader Torn data access"}</span>
            </p>
            {#if accessSummary.accessType}
              <p class="text-xs text-fg-faint">{accessSummary.accessType} key{accessSummary.level !== null ? ` · Torn access level ${accessSummary.level}` : ""}</p>
            {/if}
          </div>

          <p class="text-center text-xs text-fg-faint">
            TornScope modules:
            {#if detected.capabilities}
              {moduleAvailability(detected.capabilities).filter((m) => m.available).length} available
              {#if moduleAvailability(detected.capabilities).some((m) => !m.available)}
                · {moduleAvailability(detected.capabilities).filter((m) => !m.available).length} partial/unavailable
              {:else}
                · full supported analytics available
              {/if}
            {:else}
              —
            {/if}
          </p>

          <div class="grid gap-1.5 rounded-xl border border-border bg-bg-raise px-4 py-4 text-[13px] sm:grid-cols-2">
            <div>
              <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-positive">Available with this key</p>
              <ul class="mt-1 space-y-0.5 text-fg-muted">
                {#each accessSummary.available as label (label)}
                  <li>· {label}</li>
                {/each}
              </ul>
            </div>
            <div>
              <p class="text-[10px] font-semibold uppercase tracking-[0.12em] {limitedAccess ? 'text-fg-faint' : 'text-positive'}">
                {limitedAccess ? "Unavailable with this key" : "Complete coverage"}
              </p>
              <ul class="mt-1 space-y-0.5 text-fg-faint">
                {#each accessSummary.unavailable as item (item.label)}
                  <li>· {item.label}</li>
                {/each}
                {#if accessSummary.unavailable.length === 0}
                  <li>· Everything TornScope supports</li>
                {/if}
              </ul>
            </div>
          </div>

          {#if detected.capabilities}
            <details class="rounded-xl border border-border bg-bg-raise px-4 py-3">
              <summary class="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint transition-colors hover:text-fg-muted">
                See exactly what this key allows TornScope to read
              </summary>
              <ul class="mt-2 grid gap-1 text-[12px] sm:grid-cols-2">
                {#each capabilityList(detected.capabilities) as cap (cap.label)}
                  <li class="flex items-center gap-2">
                    <span class="h-1.5 w-1.5 rounded-full {cap.granted ? 'bg-positive' : 'bg-border-strong'}"></span>
                    <span class={cap.granted ? "text-fg-muted" : "text-fg-faint"}>{cap.label}</span>
                    {#if !cap.granted}<span class="text-[10px] uppercase tracking-wide text-fg-faint">not granted</span>{/if}
                  </li>
                {/each}
              </ul>
            </details>
          {/if}

          <p class="text-center text-[13px] leading-relaxed text-fg-muted">
            {#if limitedAccess}
              You can continue with this key. TornScope will only sync data your key permits —
              unavailable areas are clearly marked, never shown as zeros. Collected history is kept
              forever, and upgrading the key later fills in what it missed.
            {:else}
              {accessSummary.note}
            {/if}
          </p>

          {#if error}
            <p class="text-sm text-negative">{error}</p>
          {/if}

          <button
            class="w-full rounded-xl bg-accent-strong py-3 text-sm font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40"
            disabled={saving}
            onclick={() => void startTracking()}
          >
            {saving ? "Connecting…" : "Continue with this key — start tracking"}
          </button>
          <button class="w-full text-center text-xs text-fg-faint transition-colors hover:text-fg" onclick={backToKeyForm}>
            Use a different key
          </button>
        </div>
      {:else if step === 3 && existing}
        <!-- Existing TornScope profile found: link, don't duplicate -->
        <div class="space-y-5">
          <div class="space-y-1 text-center">
            <p class="text-sm font-semibold text-warning">Existing TornScope profile found</p>
            <p class="text-[13px] text-fg-muted">
              {existing.profile.name ?? "Player"} [{existing.profile.tornId}] already has a TornScope profile with collected history.
            </p>
          </div>

          <dl class="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-border bg-bg-raise px-4 py-4 text-[13px]">
            <div>
              <dt class="text-[11px] uppercase tracking-[0.14em] text-fg-faint">Player</dt>
              <dd class="mt-0.5 text-fg">{existing.profile.name ?? "Player"} [{existing.profile.tornId}]</dd>
            </div>
            <div>
              <dt class="text-[11px] uppercase tracking-[0.14em] text-fg-faint">History</dt>
              <dd class="mt-0.5 text-fg">Existing history available</dd>
            </div>
            <div>
              <dt class="text-[11px] uppercase tracking-[0.14em] text-fg-faint">Current stored access</dt>
              <dd class="mt-0.5 text-fg">{existing.profile.storedAccess?.type ?? "Not connected"}{existing.profile.storedAccess?.level ? ` (lvl ${existing.profile.storedAccess.level})` : ""}</dd>
            </div>
            <div>
              <dt class="text-[11px] uppercase tracking-[0.14em] text-fg-faint">Verification key</dt>
              <dd class="mt-0.5 text-fg">{existing.incoming.accessType ?? "Unknown"}{existing.incoming.accessLevel ? ` (lvl ${existing.incoming.accessLevel})` : ""}</dd>
            </div>
            <div class="col-span-2">
              <dt class="text-[11px] uppercase tracking-[0.14em] text-fg-faint">Stored data</dt>
              <dd class="mt-0.5 text-fg-muted">
                {existing.profile.history.timelineEvents.toLocaleString("en-US")} timeline events ·
                {existing.profile.history.moneyEvents.toLocaleString("en-US")} money entries ·
                {existing.profile.history.travelTrips.toLocaleString("en-US")} trips
              </dd>
            </div>
          </dl>

          <p class="text-center text-xs leading-relaxed text-fg-muted">
            Using the existing profile does <span class="font-semibold text-fg">not</span> replace the stored API key.
            Your other signed-in browsers stay signed in, and no historical data is imported again.
          </p>

          <button
            class="w-full rounded-xl bg-accent-strong py-3 text-sm font-semibold text-bg transition-colors hover:bg-accent disabled:opacity-40"
            disabled={linking || replacing}
            onclick={() => void useExistingProfile()}
          >
            {linking ? "Linking…" : "Use existing profile"}
          </button>

          <div class="space-y-2">
            <button
              class="w-full rounded-xl border border-warning/40 py-2.5 text-xs font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-40"
              disabled={linking || replacing}
              onclick={() => void replaceStoredKey()}
            >
              {replacing ? "Replacing…" : `Replace stored key with this ${existing.incoming.accessType ?? ""} key`}
            </button>
            {#if existing.downgrade}
              <p class="text-center text-[11px] leading-relaxed text-warning">
                Replacing this key reduces available permissions. Some TornScope analytics may stop refreshing.
                Collected history is never deleted.
              </p>
            {/if}
            <button class="w-full text-center text-xs text-fg-faint transition-colors hover:text-fg" onclick={cancelLink}>
              Cancel
            </button>
          </div>

          {#if error}
            <p class="text-sm text-negative">{error}</p>
          {/if}
        </div>
      {:else if step === 3}
        <div class="flex flex-col items-center gap-4 py-6">
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-border-strong border-t-accent"></div>
          <p class="text-sm text-fg-muted">Key saved. Kicking off the initial sync of your Torn history…</p>
        </div>
      {:else}
        <div class="space-y-5">
          <div class="space-y-1 text-center">
            <p class="text-sm font-semibold text-positive">Account connected — live data is available.</p>
            <p class="mx-auto max-w-sm text-[13px] leading-relaxed text-fg-muted">
              You can start exploring now; the historical import continues in the background.
            </p>
            <p class="mx-auto max-w-sm text-[11px] leading-relaxed text-fg-faint">
              TornScope imports up to 180 days of available Torn history. Retention varies by Torn log type.
            </p>
          </div>

          {#if me.data?.capabilities}
            <div class="rounded-xl border border-border bg-bg-raise px-4 py-3">
              <div class="flex items-center justify-between">
                <span class="text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-faint">Detected API access</span>
                <span class="text-sm font-semibold text-fg">{me.data.accessType ?? "Detected"}{me.data.accessLevel ? ` · level ${me.data.accessLevel}` : ""}</span>
              </div>
              {#if me.data.accessLevel !== null && me.data.accessLevel < 4}
                <p class="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
                  Limited Access — TornScope only syncs what this key permits. Resources the key cannot
                  answer are skipped below, never rendered as zeros.
                </p>
              {/if}
              <div class="mt-2 grid gap-1.5 text-[12px] sm:grid-cols-2">
                <div>
                  <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-positive">Available</p>
                  <ul class="mt-0.5 space-y-0.5 text-fg-muted">
                    {#each availableModules as m (m.module)}
                      <li>· {m.module[0]!.toUpperCase() + m.module.slice(1)}</li>
                    {/each}
                  </ul>
                </div>
                <div>
                  <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-faint">Needs more access</p>
                  <ul class="mt-0.5 space-y-0.5 text-fg-faint">
                    {#each unavailableModules as m (m.module)}
                      <li>· {m.module[0]!.toUpperCase() + m.module.slice(1)}</li>
                    {/each}
                    {#if unavailableModules.length === 0}
                      <li>· Everything, with this key</li>
                    {/if}
                  </ul>
                </div>
              </div>
            </div>
          {/if}

          <!-- Resource-level progress (no invented overall percentage).
               Capability-blocked resources show an explicit skip so the
               Limited-vs-Full behavior is understandable at a glance. -->
          <div class="rounded-xl border border-border bg-bg-raise px-4 py-2">
            {#each syncRows as row (row.resource)}
              <div class="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-0">
                <span class="text-[13px] {rowState(row).skipped ? 'text-fg-faint' : 'text-fg'}">{RESOURCE_LABELS[row.resource] ?? row.resource}</span>
                <span class="tnum text-right text-xs {rowState(row).cls}">{rowState(row).label}</span>
              </div>
            {:else}
              <p class="py-3 text-center text-xs text-fg-faint">
                {syncRunning ? "Starting the initial sync…" : "Waiting for the first sync…"}
              </p>
            {/each}
          </div>

          <button class="w-full rounded-xl bg-accent-strong py-3 text-sm font-semibold text-bg transition-colors hover:bg-accent" onclick={openApp}>
            Open Today
          </button>
          <div class="flex items-center justify-center gap-4 text-xs">
            <a href="/sync" class="text-fg-muted transition-colors hover:text-accent">Sync status</a>
            {#if syncRows.some((r) => r.errorMessage && r.lastSuccessAt === null)}
              <button class="text-fg-muted transition-colors hover:text-accent disabled:opacity-40" onclick={() => void retryFailed()} disabled={retrying}>
                {retrying ? "Retrying…" : "Retry failed sync"}
              </button>
            {/if}
          </div>
          {#if me.data?.torn}
            <p class="text-center text-xs text-fg-faint">Detected player: {me.data.torn.name} [{me.data.torn.tornId}]</p>
          {/if}
        </div>
      {/if}
    </div>

    {#if (step === 2 && detected?.tornId) || (step !== 2 && step !== 4 && status?.tornId)}
      <p class="text-center text-xs text-fg-muted">
        Detected player: <span class="text-fg">{step === 2 ? detected?.tornName : status?.tornName}</span> [{step === 2 ? detected?.tornId : status?.tornId}]
      </p>
    {/if}
  </div>
</div>
