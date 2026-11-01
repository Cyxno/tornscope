<script lang="ts">
  import { endpoints, ApiClientError } from "$lib/api";
  import { formatRelative } from "$lib/reltime";
  import Panel from "$lib/components/Panel.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import StateMessage from "$lib/components/StateMessage.svelte";
  import type {
    AlertRuleDto,
    AlertRulesResponse,
    AlertTriggerMeta,
  } from "@tornscope/shared";

  /**
   * Rules view: one accessible card per BUILT-IN trigger (the registry is
   * fixed). A rule row exists only after first enable — toggling an absent
   * rule creates it with the card's current settings, later changes PATCH.
   * No fabricated dates: lastFiredAt null renders "Never fired".
   */

  interface Props {
    /** Refresh the unread bell (no-op here; rules don't change unread). */
    onchanged?: () => void;
  }
  let { onchanged }: Props = $props();

  let data = $state<AlertRulesResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<{ tone: "ok" | "err"; text: string } | null>(null);
  /** rule id | triggerType being saved (per-card busy state). */
  let busy = $state<string | null>(null);

  /** Local editing copies keyed by triggerType (rule id when it exists). */
  let drafts = $state<Record<string, RuleDraft>>({});

  interface RuleDraft {
    cooldowns: { drug: boolean; booster: boolean; medical: boolean };
    pct: number;
    windowHours: number;
    quietEnabled: boolean;
    quietStart: string;
    quietEnd: string;
    quietTz: string;
    cooldownMinutes: number;
  }

  function emptyDraft(): RuleDraft {
    return {
      cooldowns: { drug: true, booster: true, medical: true },
      pct: 5,
      windowHours: 24,
      quietEnabled: false,
      quietStart: "23:00",
      quietEnd: "07:00",
      quietTz: "UTC",
      cooldownMinutes: 0,
    };
  }

  function draftFor(meta: AlertTriggerMeta, rule: AlertRuleDto | null): RuleDraft {
    const base = emptyDraft();
    if (!rule) return base;
    const config = rule.config ?? {};
    if (meta.id === "cooldown_ready") {
      const list = Array.isArray(config.cooldowns) ? (config.cooldowns as string[]) : null;
      base.cooldowns = {
        drug: list === null || list.includes("drug"),
        booster: list === null || list.includes("booster"),
        medical: list === null || list.includes("medical"),
      };
    }
    if (meta.id === "net_worth_drop") {
      if (typeof config.pct === "number") base.pct = config.pct;
      if (typeof config.window_hours === "number") base.windowHours = config.window_hours;
    }
    if (rule.quietHours) {
      base.quietEnabled = true;
      base.quietStart = rule.quietHours.start;
      base.quietEnd = rule.quietHours.end;
      base.quietTz = rule.quietHours.tz;
    }
    base.cooldownMinutes = rule.cooldownMinutes;
    return base;
  }

  function quietHoursPayload(draft: RuleDraft): { start: string; end: string; tz: string } | null {
    if (!draft.quietEnabled) return null;
    return { start: draft.quietStart, end: draft.quietEnd, tz: draft.quietTz };
  }

  function configPayload(meta: AlertTriggerMeta, draft: RuleDraft): Record<string, unknown> | undefined {
    if (meta.id === "cooldown_ready") {
      const chosen = (Object.entries(draft.cooldowns) as Array<[string, boolean]>)
        .filter(([, on]) => on)
        .map(([kind]) => kind);
      if (chosen.length === 0) return { cooldowns: ["drug", "booster", "medical"] };
      return { cooldowns: chosen };
    }
    if (meta.id === "net_worth_drop") {
      return { pct: draft.pct, window_hours: draft.windowHours };
    }
    return undefined;
  }

  function localValidate(meta: AlertTriggerMeta, draft: RuleDraft): string | null {
    if (meta.id === "net_worth_drop") {
      if (!Number.isFinite(draft.pct) || draft.pct < 0.5 || draft.pct > 95) return "Drop threshold must be between 0.5% and 95%.";
      if (!Number.isInteger(draft.windowHours) || draft.windowHours < 1 || draft.windowHours > 720) return "Observation window must be 1–720 hours.";
    }
    if (draft.quietEnabled) {
      const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!hhmm.test(draft.quietStart) || !hhmm.test(draft.quietEnd)) return "Quiet hours must be HH:MM (24h).";
      if (draft.quietTz.trim() === "") return "Quiet hours need a timezone.";
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: draft.quietTz });
      } catch {
        return `"${draft.quietTz}" is not a valid IANA timezone.`;
      }
    }
    if (!Number.isInteger(draft.cooldownMinutes) || draft.cooldownMinutes < 0 || draft.cooldownMinutes > 10080) {
      return "Cooldown must be 0–10080 minutes.";
    }
    return null;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await endpoints.alertsRules();
      data = res;
      const nextDrafts: Record<string, RuleDraft> = {};
      for (const meta of res.triggers) {
        nextDrafts[meta.id] = draftFor(meta, res.rules.find((r) => r.triggerType === meta.id) ?? null);
      }
      drafts = nextDrafts;
    } catch (err) {
      error = err instanceof ApiClientError ? err.message : (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function setEnabled(meta: AlertTriggerMeta, enabled: boolean): Promise<void> {
    const rule = data?.rules.find((r) => r.triggerType === meta.id) ?? null;
    const draft = drafts[meta.id] ?? emptyDraft();
    const invalid = enabled ? localValidate(meta, draft) : null;
    if (invalid) {
      notice = { tone: "err", text: `${meta.label}: ${invalid}` };
      return;
    }
    busy = rule?.id ?? meta.id;
    try {
      if (rule) {
        await endpoints.alertsUpdateRule(rule.id, { enabled });
      } else if (enabled) {
        await endpoints.alertsCreateRule({
          triggerType: meta.id,
          enabled: true,
          config: configPayload(meta, draft),
          quietHours: quietHoursPayload(draft),
          cooldownMinutes: draft.cooldownMinutes,
        });
      } else {
        return; // nothing to disable
      }
      notice = { tone: "ok", text: `${meta.label} ${enabled ? "enabled" : "disabled"}.` };
      await load();
      onchanged?.();
    } catch (err) {
      notice = { tone: "err", text: err instanceof ApiClientError ? err.message : (err as Error).message };
    } finally {
      busy = null;
    }
  }

  async function saveSettings(meta: AlertTriggerMeta): Promise<void> {
    const rule = data?.rules.find((r) => r.triggerType === meta.id) ?? null;
    const draft = drafts[meta.id] ?? emptyDraft();
    const invalid = localValidate(meta, draft);
    if (invalid) {
      notice = { tone: "err", text: `${meta.label}: ${invalid}` };
      return;
    }
    busy = rule?.id ?? meta.id;
    try {
      const payload = {
        config: configPayload(meta, draft),
        quietHours: quietHoursPayload(draft),
        cooldownMinutes: draft.cooldownMinutes,
      };
      if (rule) {
        await endpoints.alertsUpdateRule(rule.id, { ...payload, enabled: rule.enabled });
      } else {
        await endpoints.alertsCreateRule({ triggerType: meta.id, enabled: false, ...payload });
      }
      notice = { tone: "ok", text: `${meta.label} settings saved.` };
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

  const GAMEPLAY_ORDER = ["cooldown_ready", "oc_ready", "education_done", "bank_matured", "travel_landed", "net_worth_drop"];
  const OPERATIONAL_ORDER = ["sync_failure", "sync_recovery"];
  function ordered(metas: AlertTriggerMeta[], ids: string[]): AlertTriggerMeta[] {
    return ids.map((id) => metas.find((m) => m.id === id)).filter((m): m is AlertTriggerMeta => m !== undefined);
  }
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

{#if loading && !data}
  <StateMessage state="loading" title="Loading alert rules" skeleton="rows" />
{:else if error}
  <StateMessage state="error" title="Could not load alert rules" hint={error} action={{ label: "Retry", run: () => void load() }} />
{:else if data}
  <p class="section-label mb-2">Gameplay alerts</p>
  <div class="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2">
    {#each ordered(data.triggers, GAMEPLAY_ORDER) as meta (meta.id)}
      {@render ruleCard(meta)}
    {/each}
  </div>

  <p class="section-label mb-2">Operational alerts</p>
  <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
    {#each ordered(data.triggers, OPERATIONAL_ORDER) as meta (meta.id)}
      {@render ruleCard(meta)}
    {/each}
  </div>
{/if}

{#snippet ruleCard(meta: AlertTriggerMeta)}
  {@const rule = data?.rules.find((r) => r.triggerType === meta.id) ?? null}
  {@const draft = drafts[meta.id] ?? emptyDraft()}
  {@const invalid = localValidate(meta, draft)}
  <Panel>
    <div class="flex w-full items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="flex items-center gap-2 text-[14.5px] font-semibold text-fg">
          <Icon name={meta.group === "operational" ? "sync" : "bell"} size={14} class="text-fg-muted" />
          {meta.label}
        </h3>
        <p class="mt-0.5 text-[12.5px] leading-snug text-fg-muted">{meta.description}</p>
      </div>
      <label class="flex shrink-0 items-center gap-2" title={rule?.enabled === true ? "Disable this rule" : "Enable this rule"}>
        <input
          type="checkbox"
          class="h-4 w-4 accent-teal-400"
          checked={rule?.enabled === true}
          disabled={busy === (rule?.id ?? meta.id)}
          onchange={(e) => void setEnabled(meta, (e.currentTarget as HTMLInputElement).checked)}
        />
        <span class="text-[12px] text-fg-muted">{rule?.enabled === true ? "On" : "Off"}</span>
      </label>
    </div>

    <div class="space-y-3">
      {#if meta.id === "cooldown_ready"}
        <fieldset class="space-y-1.5">
          <legend class="text-[12px] font-medium text-fg-muted">Tracked cooldowns</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-1.5">
            {#each ["drug", "booster", "medical"] as kind (kind)}
              <label class="flex items-center gap-2 text-[13px] text-fg">
                <input type="checkbox" class="h-4 w-4 accent-teal-400" bind:checked={draft.cooldowns[kind as "drug"]} />
                {kind}
              </label>
            {/each}
          </div>
        </fieldset>
      {:else if meta.id === "net_worth_drop"}
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="mb-1 block text-[12px] font-medium text-fg-muted">Drop threshold (%)</span>
            <input type="number" class="input tnum" min="0.5" max="95" step="0.5" bind:value={draft.pct} />
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] font-medium text-fg-muted">Window (hours)</span>
            <input type="number" class="input tnum" min="1" max="720" step="1" bind:value={draft.windowHours} />
          </label>
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="mb-1 block text-[12px] font-medium text-fg-muted">Cooldown between alerts (minutes)</span>
          <input type="number" class="input tnum" min="0" max="10080" step="5" bind:value={draft.cooldownMinutes} />
        </label>
        <div class="flex items-end">
          <label class="flex items-center justify-between gap-3 w-full">
            <span class="text-[12px] font-medium text-fg-muted">Quiet hours</span>
            <input type="checkbox" class="h-4 w-4 accent-teal-400" bind:checked={draft.quietEnabled} />
          </label>
        </div>
      </div>

      {#if draft.quietEnabled}
        <div class="grid grid-cols-3 gap-3 rounded-tile border border-border bg-surface p-3">
          <label class="block">
            <span class="mb-1 block text-[12px] font-medium text-fg-muted">Start</span>
            <input type="time" class="input" bind:value={draft.quietStart} />
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] font-medium text-fg-muted">End</span>
            <input type="time" class="input" bind:value={draft.quietEnd} />
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] font-medium text-fg-muted">Timezone</span>
            <input type="text" class="input" placeholder="Europe/Amsterdam" bind:value={draft.quietTz} />
          </label>
          <p class="col-span-3 text-[11.5px] leading-snug text-fg-faint">
            Alerts raised inside this window are suppressed and recorded, not delivered. start = end means quiet all day.
          </p>
        </div>
      {/if}

      {#if invalid}
        <p class="text-[12.5px] text-negative">{invalid}</p>
      {/if}

      <div class="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span class="text-[12px] text-fg-faint" title={rule?.lastFiredAtSec === null || rule === null ? "This rule has never fired" : undefined}>
          {#if rule?.lastFiredAtSec != null}
            Last fired {formatRelative(rule.lastFiredAtSec)}
          {:else}
            Never fired
          {/if}
        </span>
        <button class="btn btn-sm" disabled={busy !== null || invalid !== null} onclick={() => void saveSettings(meta)}>
          {busy === (rule?.id ?? meta.id) ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  </Panel>
{/snippet}
