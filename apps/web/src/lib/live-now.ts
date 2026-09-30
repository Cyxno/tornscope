/**
 * "Right now" board derivation (1.0.3 polish) — the pure logic behind the
 * Overview live-status cards, extracted from LiveNow.svelte so the item
 * rules are unit-testable (the Bank-investment regression: an active
 * investment maturing beyond 7 days was hidden by a narrow render window;
 * the card must render for ANY active investment).
 *
 * Uses the SAME shared helpers (cooldownDisplay / barFullDisplay /
 * formatCountdownCompact) as the Today page — identical payload + clock =
 * identical state everywhere. The display-zone time formatter is injected
 * so tests don't need the reactive time-display module.
 *
 * Priority order follows gameplay urgency (B1): travel/OC/education/bank
 * timers before hospital/jail notices before cooldowns. Every item carries
 * its Torn.com destination (the primary whole-card action) and may carry a
 * TornScope analytics route as an explicit secondary link.
 */
import type { TodayResponse } from "@tornscope/shared";
import { formatCountdownCompact, formatMoneyCompact, remainingSeconds, TORN_URLS } from "@tornscope/shared";
import { cooldownDisplay, barFullDisplay } from "./live";

export interface LiveItem {
  key: string;
  label: string;
  /** Current-state line ("Returning to Torn", "212 / 240", "Active"). */
  state: string | null;
  /** Big relative countdown text; null when nothing is ticking. */
  relative: string | null;
  /** Absolute clock time the countdown points at (display zone). */
  absolute: string | null;
  /** Proportional fill 0-100 for bar cards. */
  pct?: number;
  tone: "neutral" | "negative" | "accent" | "warning" | "positive";
  /** Ready/full/matured — the actionable state worth emphasizing. */
  ready: boolean;
  /** Primary whole-card action destination (guarded Torn.com URL). */
  tornUrl: string;
  /** Screen-reader destination for the stretched card link. */
  tornLabel: string;
  /** Secondary TornScope analytics route, rendered as its own link. */
  scopeHref: string | null;
  scopeLabel: string | null;
  /** High visual priority (flight in progress / abroad / landed): renders
   *  at the TOP of the active-states block with an accent marker. */
  priority?: boolean;
  /** Urgency tier for the cockpit ordering: 1 hard state/location, 2
   *  actionable now, 3 finishing soon (<1h), 4 later. */
  urgencyTier: number;
  /** Numeric remaining seconds for time-ASC tie-breaking. */
  remainingSeconds: number | null;
}

export interface LiveBoard {
  bars: LiveItem[];
  timers: LiveItem[];
}

type Ocs = Array<{ name: string; tier: number | null; status: string; readyAt: number | null; myParticipation: boolean }>;

export function deriveLiveBoard(
  today: TodayResponse | null,
  ocs: Ocs | null,
  serverNowMs: number,
  displayTime: (tsSec: number) => string
): LiveBoard {
  if (!today) return { bars: [], timers: [] };
  const nowSec = Math.floor(serverNowMs / 1000);
  const timers = deriveTimers(today, ocs, nowSec, serverNowMs, displayTime);
  // Cockpit ordering (2.0.5): cooldown tiles keep their fixed strip order;
  // every OTHER state sorts by urgency tier, then time remaining ASC; the
  // canonical Home row is ALWAYS last.
  const home = timers.find((i) => i.key === "travel" && i.state === "Home");
  const tiles = timers.filter((i) => i.key.startsWith("cd-"));
  const rest = timers.filter((i) => i !== home && !i.key.startsWith("cd-"));
  rest.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    if (a.urgencyTier !== b.urgencyTier) return a.urgencyTier - b.urgencyTier;
    return (a.remainingSeconds ?? Number.MAX_SAFE_INTEGER) - (b.remainingSeconds ?? Number.MAX_SAFE_INTEGER);
  });
  return { bars: deriveBars(today, serverNowMs, displayTime), timers: [...rest, ...tiles, ...(home ? [home] : [])] };
}

/* -------------------------------------------------------------------------- */
/* Travel — a CANONICAL live state with RESOURCE-SPECIFIC freshness (2.0.6)    */
/* -------------------------------------------------------------------------- */

export type TravelStateKind = "home" | "flying" | "returning" | "landing" | "abroad" | "unavailable" | "stale";

export interface TravelStatusView {
  kind: TravelStateKind;
  /** Row headline: "Home", "Flying to Japan", "Returning from Japan",
   *  "Landing…", "Abroad · Japan", "Travel data stale · 42m old",
   *  "Travel status unavailable". */
  state: string | null;
  relative: string | null;
  absolute: string | null;
  tone: LiveItem["tone"];
  ready: boolean;
  /** Flight/abroad/landing render at the TOP of active states, accent-marked. */
  priority: boolean;
  /** Travel-SPECIFIC staleness (never inherits the whole-payload flag). */
  stale: boolean;
}

/**
 * Payload data older than this cannot honestly claim "Home" on its own —
 * unless the travel RESOURCE itself was confirmed more recently (worker
 * sync), which the payload carries as `travel.syncedAt`.
 */
export const TRAVEL_STALE_AFTER_SECONDS = 30 * 60;

/**
 * When the recorded landing time has passed but no fresh confirmation has
 * arrived yet, the row reads "Landing…" (transition) for at most this long —
 * beyond it the honest answer is "Travel data stale".
 */
export const LANDING_CONFIRM_GRACE_SECONDS = 5 * 60;

/**
 * The ONE travel derivation. Every Overview render shows exactly ONE travel
 * row — hidden is never a travel state:
 *   home | flying | returning | landing | abroad | unavailable | stale.
 *
 * FRESHNESS IS RESOURCE-SPECIFIC (2.0.6): the whole-payload `stale` flag
 * (one failed upstream refresh) does NOT mark travel stale. Travel is fresh
 * when either the served payload is live, or the travel RESOURCE itself was
 * worker-synced more recently (`travel.syncedAt`). A future `landsAt` is a
 * fact confirmed by Torn ahead of time and stays valid on a somewhat older
 * payload — flying never degrades to stale merely because the payload is a
 * few minutes old.
 *
 * Boundary semantics (freshness A–D from the audit):
 * - FRESH: payload live, or travel synced recently.
 * - TRANSITIONING ("landing"): recorded landing time passed and the state is
 *   not yet confirmed — shown as "Landing…" for at most the grace window.
 * - STALE: no travel confirmation within the window.
 * - UNAVAILABLE: the section itself reported an outage/permission gap.
 */
export function deriveTravelStatus(
  today: TodayResponse,
  nowSec: number,
  serverNowMs: number,
  displayTime: (tsSec: number) => string
): TravelStatusView {
  const t = today.travel;

  // ---- Travel-specific freshness (never the global payload flag) ----------
  const fetchedSec = Math.floor(today.fetchedAt / 1000);
  const payloadFresh = today.stale !== true;
  const syncedSec = t.syncedAt ?? null;
  const confirmedSec = Math.max(payloadFresh ? fetchedSec : 0, syncedSec ?? 0);
  const confirmedAgeSec = confirmedSec > 0 ? Math.max(0, nowSec - confirmedSec) : null;
  const travelStale = confirmedSec === 0 || (confirmedAgeSec !== null && confirmedAgeSec > TRAVEL_STALE_AFTER_SECONDS);
  const staleCopy = `Travel data stale${confirmedAgeSec !== null ? ` · ${formatCountdownCompact(confirmedAgeSec)} old` : ""}`;

  if (t.state === "unavailable") {
    return {
      kind: "unavailable",
      state: t.requiredAccess ? `Travel status unavailable — ${t.requiredAccess}` : "Travel status unavailable",
      relative: null,
      absolute: null,
      tone: "neutral",
      ready: false,
      priority: false,
      stale: true,
    };
  }

  if (t.state === "traveling") {
    const landsAt = t.landsAt;

    // A future landing time is a fact Torn confirmed when the flight started:
    // the countdown stays valid even on a somewhat older payload.
    if (landsAt !== null && landsAt > nowSec) {
      const returning = t.direction === "returning";
      return {
        kind: returning ? "returning" : "flying",
        state: returning ? (t.country ? `Returning from ${t.country}` : "Returning to Torn") : `Flying to ${t.country ?? "abroad"}`,
        relative: formatCountdownCompact(landsAt - nowSec),
        absolute: displayTime(landsAt),
        tone: "accent",
        ready: false,
        priority: true,
        stale: false,
      };
    }

    // Landing boundary crossed. Was the crossing CONFIRMED by a fetch/sync
    // that happened after it? Then a fresh Torn still saying "traveling"
    // means the flight state is what it is — trust the fresh read (flying).
    const confirmedAfterLanding = confirmedSec >= (landsAt ?? 0) && landsAt !== null;
    if (confirmedAfterLanding && payloadFresh) {
      const returning = t.direction === "returning";
      return {
        kind: returning ? "returning" : "flying",
        state: returning ? (t.country ? `Returning from ${t.country}` : "Returning to Torn") : `Flying to ${t.country ?? "abroad"}`,
        relative: t.landsAt !== null ? formatCountdownCompact(Math.max(0, t.landsAt - nowSec)) : null,
        absolute: t.landsAt !== null ? displayTime(t.landsAt) : null,
        tone: "accent",
        ready: false,
        priority: true,
        stale: false,
      };
    }

    // Unconfirmed crossing: within the grace window this reads as the honest
    // TRANSITION state — the timer ran out and TornScope is confirming now.
    const sinceLanding = nowSec - (landsAt ?? nowSec);
    if (sinceLanding <= LANDING_CONFIRM_GRACE_SECONDS) {
      return {
        kind: "landing",
        state: "Landing…",
        relative: null,
        absolute: t.landsAt !== null ? displayTime(t.landsAt) : null,
        tone: "accent",
        ready: false,
        priority: true,
        stale: false,
      };
    }

    // Beyond the grace window without confirmation: honestly stale (with age
    // since the landing, the moment the user actually cares about).
    return {
      kind: "stale",
      state: `Travel data stale · ${formatCountdownCompact(sinceLanding)} since landing`,
      relative: null,
      absolute: null,
      tone: "warning",
      ready: false,
      priority: false,
      stale: true,
    };
  }

  if (t.state === "abroad") {
    return {
      kind: "abroad",
      state: t.country ? `Abroad · ${t.country}` : "Abroad",
      relative: null,
      absolute: null,
      tone: "accent",
      ready: true,
      priority: true,
      stale: travelStale,
    };
  }

  // Home: a stable confirmed state — claimed when the data supports it.
  if (travelStale) {
    return {
      kind: "stale",
      state: staleCopy,
      relative: null,
      absolute: null,
      tone: "warning",
      ready: false,
      priority: false,
      stale: true,
    };
  }
  return {
    kind: "home",
    state: "Home",
    relative: null,
    absolute: null,
    tone: "neutral",
    ready: false,
    priority: false,
    stale: false,
  };
}

function deriveBars(today: TodayResponse, serverNowMs: number, displayTime: (tsSec: number) => string): LiveItem[] {
  const kinds = [
    { kind: "energy" as const, label: "Energy", url: TORN_URLS.gym, action: "Open the gym" },
    { kind: "nerve" as const, label: "Nerve", url: TORN_URLS.crimes, action: "Open crimes" },
    { kind: "happy" as const, label: "Happy", url: TORN_URLS.items, action: "Open items" },
    // Cockpit overview (2.x): Life joins the dominant live-status block —
    // "timer only when relevant" is barFullDisplay's job (Full / Full in Xm).
    { kind: "life" as const, label: "Life", url: TORN_URLS.items, action: "Open items" },
  ];
  const out: LiveItem[] = [];
  for (const { kind, label, url, action } of kinds) {
    const bar = today.bars[kind];
    const d = barFullDisplay(bar, serverNowMs);
    if (!bar || !d) continue;
    if (d.overCap) {
      // Stacked (e.g. energy 400/150 on Xanax): show the REAL current, the
      // natural cap and the over-cap amount. No countdown exists (regen is
      // stopped above the cap) and the bar stays contained at 100% fill with
      // the normal accent treatment — stacking is intentional, not an error.
      out.push(item({
        key: kind,
        label,
        state: `${bar.current} / ${bar.max}`,
        relative: d.text,
        pct: 100,
        tone: "accent",
        ready: false,
        tornUrl: url,
        tornLabel: action,
      }));
      continue;
    }
    if (d.full) {
      out.push(item({ key: kind, label, state: `${bar.current} / ${bar.max}`, pct: 100, tone: "positive", ready: true, tornUrl: url, tornLabel: action }));
      continue;
    }
    const ticking = d.text.startsWith("Full in");
    out.push(item({
      key: kind,
      label,
      state: `${bar.current} / ${bar.max}`,
      relative: ticking ? d.text.slice("Full in ".length) : d.text === "—" ? null : d.text,
      absolute: ticking && bar.fullAt !== null ? displayTime(bar.fullAt) : null,
      pct: Math.min(100, Math.max(2, bar.percent)),
      tone: "accent",
      ready: false,
      tornUrl: url,
      tornLabel: action,
    }));
  }
  return out;
}

function deriveTimers(
  today: TodayResponse,
  ocs: Ocs | null,
  nowSec: number,
  serverNowMs: number,
  displayTime: (tsSec: number) => string
): LiveItem[] {
  const out: LiveItem[] = [];
  const t = today;

  // TRAVEL — canonical live state, ALWAYS rendered exactly once. Flights,
  // returns, landed and abroad are high-priority rows at the TOP; the
  // compact Home row closes the block (hidden ≠ healthy).
  const travel = deriveTravelStatus(today, nowSec, serverNowMs, displayTime);
  if (travel.kind !== "home") {
    out.push(item({
      key: "travel",
      label: "Travel",
      state: travel.state,
      relative: travel.relative,
      absolute: travel.absolute,
      tone: travel.tone,
      ready: travel.ready,
      priority: travel.priority,
      urgencyTier: 1,
      remainingSeconds: travel.kind === "flying" || travel.kind === "returning" ? (t.travel.landsAt !== null ? t.travel.landsAt - nowSec : null) : null,
      tornUrl: TORN_URLS.travel,
      tornLabel: "Open travel",
      scopeHref: "/travel",
      scopeLabel: "Travel history",
    }));
  }

  // Organized crime — faction crimes tab is the action.
  if (ocs) {
    const mine = ocs.filter((o) => o.myParticipation && (o.status === "Recruiting" || o.status === "Planning"));
    const oc = mine[0];
    if (oc) {
      let relative: string | null = null;
      let absolute: string | null = null;
      let ready = false;
      if (oc.readyAt !== null) {
        const left = oc.readyAt - nowSec;
        if (left > 0) {
          relative = formatCountdownCompact(left);
          absolute = displayTime(oc.readyAt);
        } else {
          ready = true;
        }
      }
      const ocRemaining = oc.readyAt !== null ? oc.readyAt - nowSec : null;
      out.push(item({
        key: "oc",
        label: `OC · ${oc.name}${oc.tier !== null ? ` · T${oc.tier}` : ""}`,
        state: oc.status,
        relative,
        absolute,
        tone: ready ? "positive" : "accent",
        ready,
        urgencyTier: ready ? 2 : ocRemaining !== null && ocRemaining <= 3600 ? 3 : 4,
        remainingSeconds: ocRemaining,
        tornUrl: TORN_URLS.organizedCrime,
        tornLabel: "Open organized crime",
        scopeHref: "/faction",
        scopeLabel: "Faction",
      }));
    }
  }

  if (t.education.state === "active" && t.education.completesAt !== null && t.education.completesAt > nowSec) {
    const eduRemaining = t.education.completesAt - nowSec;
    out.push(item({
      key: "education",
      label: "Education",
      state: "Course in progress",
      relative: formatCountdownCompact(eduRemaining),
      absolute: displayTime(t.education.completesAt),
      tone: "neutral",
      ready: false,
      urgencyTier: eduRemaining <= 3600 ? 3 : 4,
      remainingSeconds: eduRemaining,
      tornUrl: TORN_URLS.education,
      tornLabel: "Open education",
    }));
  }

  // Bank investment — renders for ANY active investment, however far the
  // maturity (the 1.0.3 regression: investments beyond a 7-day window
  // disappeared). MATURE = READY TO COLLECT (B): Torn keeps the payout in
  // the bank until the user withdraws, and reports it by CLEARING the
  // until-timestamp — so a mature state with no timer is the actionable
  // case, shown with the payout amount as the prominent figure.
  if (t.bank.state === "active" || t.bank.state === "mature") {
    const left = t.bank.maturesAt !== null ? t.bank.maturesAt - nowSec : null;
    if (t.bank.state === "mature" || (left !== null && left <= 0)) {
      out.push(item({
        key: "bank", label: "Bank", state: "Ready to collect",
        relative: t.bank.amount !== null ? formatMoneyCompact(t.bank.amount) : null,
        tone: "warning", ready: true, urgencyTier: 2, remainingSeconds: 0,
        tornUrl: TORN_URLS.bank, tornLabel: "Collect your bank investment",
        scopeHref: "/money", scopeLabel: "Money",
      }));
    } else if (left !== null) {
      out.push(item({
        key: "bank", label: "Bank", state: "Investment active",
        relative: formatCountdownCompact(left),
        absolute: t.bank.maturesAt !== null ? displayTime(t.bank.maturesAt) : null,
        tone: "neutral", ready: false,
        urgencyTier: left <= 3600 ? 3 : 4, remainingSeconds: left,
        tornUrl: TORN_URLS.bank, tornLabel: "Open bank", scopeHref: "/money", scopeLabel: "Money",
      }));
    } else {
      out.push(item({
        key: "bank", label: "Bank", state: "Investment active", tone: "neutral", ready: false,
        urgencyTier: 4,
        tornUrl: TORN_URLS.bank, tornLabel: "Open bank", scopeHref: "/money", scopeLabel: "Money",
      }));
    }
  }

  // Hospital / jail — normalized notices, classified server-side.
  for (const [key, notice] of [["hospital", t.hospital], ["jail", t.jail]] as const) {
    if (!notice) continue;
    const left = notice.releasedAt !== null ? remainingSeconds(serverNowMs, notice.releasedAt) : null;
    out.push(item({
      key,
      label: notice.kind === "hospital" ? "Hospital" : "Jail",
      state: "Held indefinitely",
      relative: left !== null && left > 0 ? formatCountdownCompact(left) : null,
      absolute: left !== null && left > 0 && notice.releasedAt !== null ? displayTime(notice.releasedAt) : null,
      tone: notice.kind === "hospital" ? "negative" : "warning",
      ready: false,
      urgencyTier: 1,
      remainingSeconds: left,
      tornUrl: notice.kind === "hospital" ? TORN_URLS.hospital : TORN_URLS.jail,
      tornLabel: notice.kind === "hospital" ? "Open hospital" : "Open jail",
      scopeHref: "/today",
      scopeLabel: "Today",
    }));
  }

  // Cooldowns last (lowest urgency); Ready states render positively.
  const defs = [
    { cd: t.cooldowns.drug, key: "drug", label: "Drug" },
    { cd: t.cooldowns.booster, key: "booster", label: "Booster" },
    { cd: t.cooldowns.medical, key: "medical", label: "Medical" },
  ] as const;
  for (const { cd, key, label } of defs) {
    if (cd === null) continue;
    const display = cooldownDisplay(cd, serverNowMs);
    if (display === null) continue;
    const endsAt = display.active && cd.endsAt !== null ? cd.endsAt : null;
    out.push(item({
      key: `cd-${key}`,
      label: `${label} cooldown`,
      state: display.active ? null : "Ready",
      relative: display.active ? display.text : null,
      absolute: endsAt !== null ? displayTime(endsAt) : null,
      tone: display.active ? "neutral" : "positive",
      ready: !display.active,
      urgencyTier: display.active ? 2 : 2,
      remainingSeconds: endsAt !== null ? endsAt - nowSec : null,
      tornUrl: TORN_URLS.items,
      tornLabel: `Open items for the ${label.toLowerCase()} cooldown`,
    }));
  }

  // Home — compact and explicit: the user always knows where they stand.
  // Exactly ONE travel row per render: non-home states already pushed
  // theirs at the top; only HOME closes the block here.
  if (travel.kind === "home") {
    out.push(item({
      key: "travel",
      label: "Travel",
      state: travel.state,
      relative: travel.relative,
      absolute: travel.absolute,
      tone: travel.tone,
      ready: travel.ready,
      priority: travel.priority,
      tornUrl: TORN_URLS.travel,
      tornLabel: "Open travel",
      scopeHref: "/travel",
      scopeLabel: "Travel history",
    }));
  }
  return out;
}

/** Every item gets explicit nulls — no missing-field ambiguity downstream. */
function item(v: {
  key: string; label: string; state?: string | null; relative?: string | null; absolute?: string | null;
  pct?: number; tone: LiveItem["tone"]; ready: boolean; tornUrl: string; tornLabel: string;
  scopeHref?: string | null; scopeLabel?: string | null; priority?: boolean;
  urgencyTier?: number; remainingSeconds?: number | null;
}): LiveItem {
  return { state: null, relative: null, absolute: null, scopeHref: null, scopeLabel: null, priority: false, urgencyTier: 4, remainingSeconds: null, ...v };
}
