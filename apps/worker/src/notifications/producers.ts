import { getPrismaClient, bigintToNumber } from "@tornscope/database";
import { buildBattlestatSeries, detectStatMilestones, type BattlestatPoint } from "@tornscope/analytics";
import {
  capabilityLostCopy,
  dayKeyInZone,
  localMinutesInZone,
  notificationType,
  RESOURCE_LABELS,
  syncProblemCopy,
} from "@tornscope/shared";
import { ingest, type IngestContext } from "./engine.js";

/**
 * Stored-data notification producers. Every producer here follows the same
 * contract (docs/NOTIFICATIONS.md § producers):
 *  - STATE TRANSITIONS, not polling facts — an event fires when observed
 *    state crosses a boundary, never merely because it holds.
 *  - FIRST-OBSERVATION SUPPRESSION — before a producer has ever run for a
 *    profile, it initializes its cursor/state silently; linking a profile,
 *    restarting the worker or enabling a type never floods.
 *  - AGE GUARDS — old or imported history is never notified as if new.
 *  - CONFIDENCE GATING — stale source data suppresses (recorded as such
 *    where a draft reaches ingest; skipped silently where there is nothing
 *    new to evaluate).
 *  - THIN — producers only translate observations into drafts; all policy
 *    (toggles, capabilities, quiet hours, dedupe, delivery) lives in ingest.
 */

export type SystemStatePatch = (patch: Record<string, unknown>) => Promise<void>;
type SystemState = Record<string, unknown> | null;

function slice(systemState: SystemState, key: string): Record<string, unknown> | null {
  const raw = systemState?.[key];
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

/** Resource ids → human words. Unknown resources fall back to a generic phrase. */
function humanResource(resource: string): string {
  return RESOURCE_LABELS[resource as keyof typeof RESOURCE_LABELS] ?? "A data source";
}

/* -------------------------------------------------------------------------- */
/* Energy & nerve (BarsSnapshot transitions — exact, fresh-only)               */
/* -------------------------------------------------------------------------- */

/** Re-arm hysteresis: fire once per crossing, re-arm only after a real drop. */
export const ENERGY_FULL_REARM = 25;
export const NERVE_FULL_REARM = 5;
export const ENERGY_NEAR_REARM = 20;

export async function evaluateEnergyProducer(
  ctx: IngestContext,
  systemState: SystemState,
  updateSystemState: SystemStatePatch,
  maxAgeSec: number
): Promise<void> {
  const nearMeta = notificationType("energy_near_full");
  const wantsNear = ctx.toggles["energy_near_full"] === true && nearMeta !== undefined;
  if (ctx.toggles["energy_full"] !== true && !wantsNear) return;

  const db = getPrismaClient();
  const nowSec = Math.floor(Date.now() / 1000);
  const latest = await db.barsSnapshot.findFirst({
    where: { userId: ctx.userId },
    orderBy: { capturedAt: "desc" },
    select: { capturedAt: true, energyCurrent: true, energyMaximum: true, happyCurrent: true },
  });
  // Confidence gate: a stale snapshot must never claim "your energy is full".
  if (!latest || nowSec - Math.floor(latest.capturedAt.getTime() / 1000) > maxAgeSec) return;

  const occurredAt = Math.floor(latest.capturedAt.getTime() / 1000);
  const observedKey = String(Math.floor(latest.capturedAt.getTime() / 1000));
  let energy = slice(systemState, "energy");
  if (energy === null) {
    // First observation: arm silently from current state — never notify.
    energy = {
      armedFull: latest.energyCurrent < latest.energyMaximum,
      armedNear: latest.energyCurrent < Math.min(ctx.config.nearFullThreshold, latest.energyMaximum - 1),
    };
    await updateSystemState({ energy });
    return;
  }

  const patch: Record<string, unknown> = { ...energy };
  const set = (key: string, value: unknown): void => {
    patch[key] = value;
  };

  // ---- Energy full ---------------------------------------------------------
  const fullArmed = energy.armedFull !== false;
  if (ctx.toggles["energy_full"] === true && fullArmed && latest.energyCurrent >= latest.energyMaximum && latest.energyMaximum > 0) {
    const outcome = await ingest(ctx.userId, {
      type: "energy_full",
      dedupeKey: `energy:full:${observedKey}`,
      occurredAt,
      title: "Energy full",
      body: "Your energy bar is full.",
      sensitiveBody: `Energy ${latest.energyCurrent} / ${latest.energyMaximum} — ready to spend.`,
      clickPath: "/today",
    }, ctx);
    if (outcome === "created") set("armedFull", false);
  } else if (latest.energyCurrent <= latest.energyMaximum - ENERGY_FULL_REARM) {
    set("armedFull", true);
  }

  // ---- Energy near full ------------------------------------------------------
  const threshold = Math.min(ctx.config.nearFullThreshold, latest.energyMaximum - 1);
  if (wantsNear && threshold >= 1) {
    const nearArmed = energy.armedNear !== false;
    if (nearArmed && latest.energyCurrent >= threshold && latest.energyCurrent < latest.energyMaximum) {
      const outcome = await ingest(ctx.userId, {
        type: "energy_near_full",
        dedupeKey: `energy:near:${ctx.config.nearFullThreshold}:${observedKey}`,
        occurredAt,
        title: "Energy nearly full",
        body: "Your energy is close to full.",
        sensitiveBody: `Energy ${latest.energyCurrent} / ${latest.energyMaximum}.`,
        clickPath: "/today",
      }, ctx);
      if (outcome === "created") set("armedNear", false);
    } else if (latest.energyCurrent <= threshold - ENERGY_NEAR_REARM) {
      set("armedNear", true);
    }
  }

  await updateSystemState({ energy: patch });
}

/* -------------------------------------------------------------------------- */
/* System: sync problems, recovery, capability loss (grouped, once per episode)*/
/* -------------------------------------------------------------------------- */

/** Two consecutive failed runs before "no longer updating" is claimed. */
export const SYNC_DEGRADED_MIN_ERRORS = 2;

export async function evaluateSystemProducer(
  ctx: IngestContext,
  systemState: SystemState,
  updateSystemState: SystemStatePatch
): Promise<void> {
  const wantsDegraded = ctx.toggles["sync_degraded"] === true;
  const wantsRecovered = ctx.toggles["sync_recovered"] === true;
  const wantsCapability = ctx.toggles["capability_lost"] === true;
  if (!wantsDegraded && !wantsRecovered && !wantsCapability) return;

  const db = getPrismaClient();
  const states = await db.syncState.findMany({
    where: { userId: ctx.userId },
    select: { resource: true, status: true, errorCount: true, lastErrorKind: true, lastSuccessAt: true, updatedAt: true },
  });

  const CAPABILITY_KINDS = new Set(["access_denied", "key_invalid", "key_paused"]);
  const capabilitySet = states
    .filter((s) => s.status === "capability_denied" || (s.lastErrorKind !== null && CAPABILITY_KINDS.has(s.lastErrorKind)))
    .map((s) => s.resource)
    .sort();
  const degradedSet = states
    .filter(
      (s) =>
        s.status === "failed" &&
        s.errorCount >= SYNC_DEGRADED_MIN_ERRORS &&
        !capabilitySet.includes(s.resource)
    )
    .map((s) => s.resource)
    .sort();

  const sys = slice(systemState, "system");
  if (sys === null) {
    // First observation: record the current health footprint silently.
    await updateSystemState({ system: { capability: capabilitySet, degraded: degradedSet } });
    return;
  }
  const prevCapability = Array.isArray(sys.capability) ? (sys.capability as string[]) : [];
  const prevDegraded = Array.isArray(sys.degraded) ? (sys.degraded as string[]) : [];
  const nowSec = Math.floor(Date.now() / 1000);

  // ---- Capability loss (critical, grouped) ---------------------------------
  const newCapability = capabilitySet.filter((r) => !prevCapability.includes(r));
  if (wantsCapability && newCapability.length > 0) {
    const copy = capabilityLostCopy(newCapability, Object.fromEntries(newCapability.map((r) => [r, humanResource(r)])));
    const stamp = states
      .filter((s) => newCapability.includes(s.resource))
      .map((s) => Math.floor(s.updatedAt.getTime() / 1000))
      .reduce((a, b) => Math.max(a, b), 0);
    await ingest(ctx.userId, {
      type: "capability_lost",
      dedupeKey: `capability:lost:${newCapability.join(",")}:${stamp}`,
      occurredAt: nowSec,
      title: copy.title,
      body: copy.body,
      clickPath: "/settings",
    }, ctx);
  }

  // ---- Newly degraded (grouped into ONE notification) ----------------------
  const newDegraded = degradedSet.filter((r) => !prevDegraded.includes(r) && !capabilitySet.includes(r));
  if (wantsDegraded && newDegraded.length > 0) {
    const copy = syncProblemCopy(newDegraded, Object.fromEntries(newDegraded.map((r) => [r, humanResource(r)])));
    await ingest(ctx.userId, {
      type: "sync_degraded",
      dedupeKey: `sync:degraded:${newDegraded.join(",")}:${nowSec}`,
      occurredAt: nowSec,
      title: copy.title,
      body: copy.body,
      clickPath: "/sync",
    }, ctx);
  }

  // ---- Recovery (low, off by default) ---------------------------------------
  if (wantsRecovered && prevDegraded.length > 0 && degradedSet.length === 0) {
    await ingest(ctx.userId, {
      type: "sync_recovered",
      dedupeKey: `sync:recovered:${prevDegraded.join(",")}:${nowSec}`,
      occurredAt: nowSec,
      title: "Data sources recovered",
      body: "All TornScope data sources are updating again.",
      clickPath: "/sync",
    }, ctx);
  }

  await updateSystemState({ system: { capability: capabilitySet, degraded: degradedSet } });
}

/* -------------------------------------------------------------------------- */
/* Progression: battlestat milestones + level ups (permanent dedupe)           */
/* -------------------------------------------------------------------------- */

/** A milestone whose crossing window ended longer ago than this is history. */
export const MILESTONE_MAX_AGE_SECONDS = 6 * 3600;

function localTime(tz: string, sec: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(sec * 1000));
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: false }).format(new Date(sec * 1000));
  }
}

export async function evaluateProgressionProducer(
  ctx: IngestContext,
  systemState: SystemState,
  updateSystemState: SystemStatePatch
): Promise<void> {
  const wantsMilestones = ctx.toggles["progression_milestone"] === true;
  const wantsLevel = ctx.toggles["level_up"] === true;
  if (!wantsMilestones && !wantsLevel) return;

  const db = getPrismaClient();
  let prog = slice(systemState, "progression");
  const nowSec = Math.floor(Date.now() / 1000);

  if (prog === null || typeof prog.statCursor !== "number") {
    // First observation: park the cursors at the current frontier.
    const [lastStat, lastLevelRow] = await Promise.all([
      db.personalStatSnapshot.findFirst({ where: { userId: ctx.userId }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true } }),
      db.userSnapshot.findFirst({ where: { userId: ctx.userId }, orderBy: { capturedAt: "desc" }, select: { level: true } }),
    ]);
    await updateSystemState({
      progression: {
        statCursor: lastStat ? Math.floor(lastStat.capturedAt.getTime() / 1000) : nowSec,
        lastLevel: lastLevelRow?.level ?? null,
      },
    });
    return;
  }

  const cursorSec = prog.statCursor as number;
  const [statRows, levelRows] = await Promise.all([
    db.personalStatSnapshot.findMany({
      where: { userId: ctx.userId, capturedAt: { gt: new Date((cursorSec - 3600) * 1000) } },
      orderBy: { capturedAt: "asc" },
      take: 72,
      select: { capturedAt: true, stats: true },
    }),
    db.userSnapshot.findMany({
      where: { userId: ctx.userId, capturedAt: { gt: new Date((cursorSec - 3600) * 1000) } },
      orderBy: { capturedAt: "asc" },
      take: 20,
      select: { capturedAt: true, level: true },
    }),
  ]);

  // ---- Battlestat milestones (crossing windows, honest wording) ------------
  if (wantsMilestones && statRows.length > 0) {
    const series: BattlestatPoint[] = buildBattlestatSeries(
      statRows.map((r) => ({ capturedAt: Math.floor(r.capturedAt.getTime() / 1000), stats: r.stats }))
    );
    const newPoints = series.filter((p) => p.t > cursorSec);
    if (newPoints.length > 0) {
      const milestones = detectStatMilestones(series);
      for (const m of milestones) {
        const windowEnd = m.crossedBetween[1];
        // Age guard: only crossings observed recently; the crossing window is
        // between two snapshots, never an invented exact time.
        if (windowEnd <= cursorSec || nowSec - windowEnd > MILESTONE_MAX_AGE_SECONDS) continue;
        const pretty = m.threshold >= 1e6 ? `${(m.threshold / 1e6).toLocaleString("en-US")}M` : m.threshold.toLocaleString("en-US");
        const from = localTime(ctx.timezone, m.crossedBetween[0]);
        const to = localTime(ctx.timezone, m.crossedBetween[1]);
        await ingest(ctx.userId, {
          type: "progression_milestone",
          dedupeKey: `progression:${m.kind}:${m.threshold}`,
          occurredAt: windowEnd,
          title: `Milestone: ${m.label} ${pretty}`,
          body: `${m.label} passed ${pretty} between ${from} and ${to}.`,
          clickPath: "/progression",
          provenance: "derived",
        }, ctx);
      }
    }
  }

  // ---- Level ups -------------------------------------------------------------
  if (wantsLevel && levelRows.length > 0) {
    let lastLevel = typeof prog.lastLevel === "number" ? prog.lastLevel : null;
    for (const row of levelRows) {
      if (lastLevel !== null && row.level > lastLevel) {
        await ingest(ctx.userId, {
          type: "level_up",
          dedupeKey: `level:${row.level}`,
          occurredAt: Math.floor(row.capturedAt.getTime() / 1000),
          title: `Level ${row.level}`,
          body: `You reached level ${row.level}.`,
          clickPath: "/progression",
        }, ctx);
      }
      lastLevel = row.level;
    }
    prog = { ...prog, lastLevel };
  }

  const maxStat = statRows.length > 0 ? Math.max(...statRows.map((r) => Math.floor(r.capturedAt.getTime() / 1000))) : cursorSec;
  await updateSystemState({ progression: { ...prog, statCursor: Math.max(cursorSec, maxStat) } });
}

/* -------------------------------------------------------------------------- */
/* Economy: major cash movement + net-worth movement (threshold, off by default)*/
/* -------------------------------------------------------------------------- */

/** Sale categories whose income is an asset conversion, never "earnings". */
const SALE_CATEGORIES = new Set(["bazaar", "items", "trading", "auction"]);

export async function evaluateEconomyProducer(
  ctx: IngestContext,
  systemState: SystemState,
  updateSystemState: SystemStatePatch
): Promise<void> {
  const wantsCash = ctx.toggles["major_cash_movement"] === true;
  const wantsNetworth = ctx.toggles["networth_movement"] === true;
  if (!wantsCash && !wantsNetworth) return;

  const db = getPrismaClient();
  let econ = slice(systemState, "economy");
  if (econ === null) {
    const [lastMoney, lastNw] = await Promise.all([
      db.moneyEvent.findFirst({ where: { userId: ctx.userId }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], select: { occurredAt: true, id: true } }),
      db.networthSnapshot.findFirst({ where: { userId: ctx.userId }, orderBy: { capturedAt: "desc" }, select: { capturedAt: true, total: true } }),
    ]);
    await updateSystemState({
      economy: {
        moneyCursor: lastMoney ? { occurredAt: Math.floor(lastMoney.occurredAt.getTime() / 1000), id: lastMoney.id } : null,
        networthCursor: lastNw ? Math.floor(lastNw.capturedAt.getTime() / 1000) : null,
        lastNetworthTotal: lastNw ? bigintToNumber(lastNw.total) : null,
      },
    });
    return;
  }

  // ---- Major cash movements (exact per-event identity) ----------------------
  if (wantsCash) {
    const cursor = econ.moneyCursor as { occurredAt: number; id: string } | null | undefined;
    const rows = await db.moneyEvent.findMany({
      where: { userId: ctx.userId, ...(cursor ? { occurredAt: { gte: new Date((cursor.occurredAt - 60) * 1000) } } : {}) },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: 50,
      select: { id: true, occurredAt: true, category: true, direction: true, amount: true, source: true, sourceRef: true },
    });
    const fresh = rows.filter((r) => !cursor || r.occurredAt.getTime() / 1000 > cursor.occurredAt || (r.occurredAt.getTime() / 1000 === cursor.occurredAt && r.id > cursor.id));
    for (const row of fresh) {
      const amount = bigintToNumber(row.amount) ?? 0;
      if (Math.abs(amount) < ctx.config.cashThreshold) continue;
      const pretty = formatMoney(amount);
      const conversion = SALE_CATEGORIES.has(row.category) && row.direction === "income";
      const catLabel = humanMoneyCategory(row.category);
      await ingest(ctx.userId, {
        type: "major_cash_movement",
        dedupeKey: `cash:${row.source}:${row.sourceRef}`,
        occurredAt: Math.floor(row.occurredAt.getTime() / 1000),
        title: conversion ? "Asset sale recorded" : row.direction === "income" ? "Large incoming payment" : "Large outgoing payment",
        body: conversion
          ? `Asset sale proceeds of ${pretty} were recorded — a conversion, not earnings.`
          : `A ${row.direction === "income" ? "deposit" : "payment"} of ${pretty} was recorded (${catLabel}).`,
        sensitiveBody: null,
        clickPath: "/money",
      }, ctx);
    }
    const lastRow = fresh[fresh.length - 1];
    if (lastRow) {
      econ = { ...econ, moneyCursor: { occurredAt: Math.floor(lastRow.occurredAt.getTime() / 1000), id: lastRow.id } };
    }
  }

  // ---- Net-worth movement (official snapshot delta — not profit) ------------
  if (wantsNetworth) {
    const cursorSec = typeof econ.networthCursor === "number" ? econ.networthCursor : null;
    const prevTotal = typeof econ.lastNetworthTotal === "number" ? econ.lastNetworthTotal : null;
    const latest = await db.networthSnapshot.findFirst({
      where: { userId: ctx.userId, ...(cursorSec ? { capturedAt: { gt: new Date(cursorSec * 1000) } } : {}) },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true, total: true },
    });
    if (latest && prevTotal !== null && cursorSec !== null) {
      const total = bigintToNumber(latest.total) ?? 0;
      const delta = total - prevTotal;
      const gapSec = Math.floor(latest.capturedAt.getTime() / 1000) - cursorSec;
      // A delta across a long gap is a fact about weeks, not a "movement" —
      // update the cursor silently instead of alarming.
      if (Math.abs(delta) >= ctx.config.networthThreshold && gapSec > 0 && gapSec <= 48 * 3600) {
        const pretty = formatMoney(Math.abs(delta));
        await ingest(ctx.userId, {
          type: "networth_movement",
          dedupeKey: `networth:${Math.floor(latest.capturedAt.getTime() / 1000)}`,
          occurredAt: Math.floor(latest.capturedAt.getTime() / 1000),
          title: delta > 0 ? "Net worth increased" : "Net worth decreased",
          body: `Net worth changed by ${delta > 0 ? "+" : "−"}${pretty} since the previous snapshot. This is a snapshot delta, not a profit figure.`,
          sensitiveBody: null,
          clickPath: "/money",
          provenance: "derived",
        }, ctx);
      }
      econ = { ...econ, networthCursor: Math.floor(latest.capturedAt.getTime() / 1000), lastNetworthTotal: total };
    } else if (latest) {
      econ = { ...econ, networthCursor: Math.floor(latest.capturedAt.getTime() / 1000), lastNetworthTotal: bigintToNumber(latest.total) ?? null };
    }
  }

  await updateSystemState({ economy: econ });
}

function formatMoney(amount: number): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "−$" : "$";
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2).replace(/\.00$/, "")}b`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1).replace(/\.0$/, "")}m`;
  return `${sign}${Math.round(abs).toLocaleString("en-US")}`;
}

function humanMoneyCategory(category: string): string {
  const map: Record<string, string> = {
    bazaar: "bazaar sale", items: "item sale", trading: "item trade", auction: "auction sale",
    jobs: "job payment", chores: "chores", stocks: "stocks", crypto: "crypto",
    city_bank: "city bank", cayman_bank: "Cayman bank", faction: "faction", attacks: "attacks",
    swings: "swings", sure_rns: "lottery", contests: "contests", bets: "bets",
  };
  return map[category] ?? category.replace(/_/g, " ");
}

/* -------------------------------------------------------------------------- */
/* Daily summary ready (once per LOCAL day, at the user's chosen minute)       */
/* -------------------------------------------------------------------------- */

export async function evaluateDailySummaryProducer(ctx: IngestContext, updateSystemState: SystemStatePatch): Promise<void> {
  if (ctx.toggles["daily_summary_ready"] !== true) return;
  const nowSec = Math.floor(Date.now() / 1000);
  const dayKey = dayKeyInZone(nowSec, ctx.timezone);
  if (localMinutesInZone(nowSec, ctx.timezone) < ctx.config.summaryTimeMin) return;

  const db = getPrismaClient();
  const existing = await db.notificationEvent.findUnique({
    where: { userId_dedupeKey: { userId: ctx.userId, dedupeKey: `daily-summary:${dayKey}` } },
    select: { id: true },
  });
  if (existing) return;

  const outcome = await ingest(ctx.userId, {
    type: "daily_summary_ready",
    dedupeKey: `daily-summary:${dayKey}`,
    occurredAt: nowSec,
    title: "Daily summary ready",
    body: "Your TornScope daily summary is prepared.",
    clickPath: "/today",
    provenance: "derived",
  }, ctx);
  if (outcome === "created") {
    await updateSystemState({ summary: { lastSentDayKey: dayKey } });
  }
}
