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
  return { bars: deriveBars(today, serverNowMs, displayTime), timers: deriveTimers(today, ocs, nowSec, serverNowMs, displayTime) };
}

/* -------------------------------------------------------------------------- */
/* Travel — a CANONICAL live state (2.x hotfix)                                */
/* -------------------------------------------------------------------------- */

export type TravelStateKind = "home" | "flying" | "returning" | "landed" | "abroad" | "unavailable" | "stale";

export interface TravelStatusView {
  kind: TravelStateKind;
  /** Row headline: "Home", "Flying to Japan", "Abroad — Japan", "Landed",
   *  "Travel data stale", "Travel status unavailable". */
  state: string | null;
  relative: string | null;
  absolute: string | null;
  tone: LiveItem["tone"];
  ready: boolean;
  /** Flight/abroad/landed render at the TOP of active states, accent-marked. */
  priority: boolean;
}

/**
 * Data older than this cannot honestly claim "Home" — it shows as stale
 * (with its age) instead. The Today payload is normally seconds old; this
 * gate only trips when the persisted last-known copy is served and a fresh
 * upstream fetch has been failing for a while.
 */
export const TRAVEL_STALE_AFTER_SECONDS = 30 * 60;

/**
 * The ONE travel derivation. Every Overview render shows exactly ONE travel
 * row — hidden is never a travel state:
 *   home | flying | returning | landed | abroad | unavailable | stale.
 */
export function deriveTravelStatus(
  today: TodayResponse,
  nowSec: number,
  serverNowMs: number,
  displayTime: (tsSec: number) => string
): TravelStatusView {
  const t = today.travel;

  // Stale data may not claim "Home". Age is shown when it can be computed.
  const fetchedSec = Math.floor(today.fetchedAt / 1000);
  const ageSec = Math.max(0, Math.floor(serverNowMs / 1000) - fetchedSec);
  if (today.stale === true || ageSec > TRAVEL_STALE_AFTER_SECONDS) {
    return {
      kind: "stale",
      state: today.stale === true ? "Travel data stale" : `Travel data stale · ${formatCountdownCompact(ageSec)} old`,
      relative: null,
      absolute: null,
      tone: "warning",
      ready: false,
      priority: false,
    };
  }

  if (t.state === "unavailable") {
    return {
      kind: "unavailable",
      state: t.requiredAccess ? `Travel status unavailable — ${t.requiredAccess}` : "Travel status unavailable",
      relative: null,
      absolute: null,
      tone: "neutral",
      ready: false,
      priority: false,
    };
  }

  if (t.state === "traveling") {
    const landed = t.landsAt !== null && t.landsAt <= nowSec;
    if (landed) {
      // Transition gap: Torn still reports "traveling" but the flight is over.
      return { kind: "landed", state: "Landed", relative: null, absolute: null, tone: "positive", ready: true, priority: true };
    }
    const returning = t.direction === "returning";
    return {
      kind: returning ? "returning" : "flying",
      state: returning ? (t.country ? `Returning from ${t.country}` : "Returning to Torn") : `Flying to ${t.country ?? "abroad"}`,
      relative: t.landsAt !== null ? formatCountdownCompact(t.landsAt - nowSec) : null,
      absolute: t.landsAt !== null ? displayTime(t.landsAt) : null,
      tone: "accent",
      ready: false,
      priority: true,
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
    };
  }

  return { kind: "home", state: "Home", relative: null, absolute: null, tone: "neutral", ready: false, priority: false };
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
      out.push(item({
        key: "oc",
        label: `OC · ${oc.name}${oc.tier !== null ? ` · T${oc.tier}` : ""}`,
        state: oc.status,
        relative,
        absolute,
        tone: ready ? "positive" : "accent",
        ready,
        tornUrl: TORN_URLS.organizedCrime,
        tornLabel: "Open organized crime",
        scopeHref: "/faction",
        scopeLabel: "Faction",
      }));
    }
  }

  if (t.education.state === "active" && t.education.completesAt !== null && t.education.completesAt > nowSec) {
    out.push(item({
      key: "education",
      label: "Education",
      state: "Course in progress",
      relative: formatCountdownCompact(t.education.completesAt - nowSec),
      absolute: displayTime(t.education.completesAt),
      tone: "neutral",
      ready: false,
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
        tone: "warning", ready: true,
        tornUrl: TORN_URLS.bank, tornLabel: "Collect your bank investment",
        scopeHref: "/money", scopeLabel: "Money",
      }));
    } else if (left !== null) {
      out.push(item({
        key: "bank", label: "Bank", state: "Investment active",
        relative: formatCountdownCompact(left),
        absolute: t.bank.maturesAt !== null ? displayTime(t.bank.maturesAt) : null,
        tone: "neutral", ready: false,
        tornUrl: TORN_URLS.bank, tornLabel: "Open bank", scopeHref: "/money", scopeLabel: "Money",
      }));
    } else {
      out.push(item({
        key: "bank", label: "Bank", state: "Investment active", tone: "neutral", ready: false,
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
}): LiveItem {
  return { state: null, relative: null, absolute: null, scopeHref: null, scopeLabel: null, priority: false, ...v };
}
