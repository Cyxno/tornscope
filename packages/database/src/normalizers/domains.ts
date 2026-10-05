import type { LogRecord } from "./extract.js";

/**
 * Domain activity registry (2.5.0) — explicit adapters for the
 * value-bearing log families the v2.4.0 production audit left uncovered:
 * hunting, missions, racing, bounties, education. Built ONLY from actual
 * raw payload shapes observed in the stored archive (utilization audit,
 * 2026-10): every parser anchors on the category AND the exact log title
 * AND the presence of the semantic payload keys — never a bare keyword.
 *
 * SEMANTICS PER FAMILY (from the stored archive):
 * - Hunting (session):  {cost, income, session_type, hunting_skill,
 *               hunting_skill_gain} — one log = one hunting session;
 *               cost exact stake, income exact prey sales, net = income − cost.
 * - Hunting skill level up: {skill_level} — progression milestone, no value
 *               components (skill level stays in the payload).
 * - Missions complete:  {type, agent, money, credits, mission, difficulty} —
 *               cash reward exact (0 = known zero, credits-only completions
 *               exist); credits are mission credits, a DISTINCT special
 *               currency (carried in tokensReward with the domain as the
 *               unit discriminator — never casino tokens).
 * - Racing finish official race: {car, track, race_id, position,
 *               racing_points, racing_skill} — performance only, no cash;
 *               position ordinal and "N racing point(s)" grammar parsed
 *               exactly; racing skill gain stays in the payload.
 * - Racing upgrade car: {car, cost, upgrade, racing_points} — upgrade spend
 *               exact; committed cost, net = −cost.
 * - Bounty place:       {cost, target, bounty_reward, quantity, reason,
 *               anonymous} — placing a bounty is a committed expense
 *               (cost exact); bounty_reward is what a CLAIMER receives and
 *               is NOT the placer's spend.
 * - Bounty claim:       {bounty_reward, target, lister, anonymous} — claim
 *               income exact (bounty_reward).
 * - Education start:    {cost, course, duration} — course cost exact and
 *               committed at start; no completion log is claimed (drawn
 *               ROI is never fabricated).
 *
 * Directional rule (never all-same-direction): place/upgrade/start are
 * costs, claims/completions are income, sessions are both. Payout logs and
 * stakes are never merged into one direction.
 */

export type ActivityDomain = "hunting" | "missions" | "racing" | "bounties" | "education";

export interface DomainActivity {
  domain: ActivityDomain;
  activityType: string;
  activityLabel: string;
  subtype: string | null;
  outcome: string | null;
  opponentId: number | null;
  /** Exact committed cash (cost/stake/spend). */
  cashInput: bigint | null;
  /** Exact cash received (reward/income/payout). */
  cashReward: bigint | null;
  /** Exact progression/special-currency quantity — unit is domain-specific
   *  (racing: racing points; missions: mission credits via tokensReward). */
  pointsReward: number | null;
  tokensReward: number | null;
  /** Exact net cash where the log itself settles it (null when pending). */
  netValue: bigint | null;
  /** "exact" when any cash component is present, else "unpriced". */
  valuation: "exact" | "unpriced";
  provenance: "exact";
}

function num(data: LogRecord, key: string): bigint | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? BigInt(Math.round(v)) : null;
}

function int(data: LogRecord, key: string): number | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** "and gained 0.0945 hunting skill" → 0.0945 (null when absent/other). */
function skillGain(data: LogRecord, key: string): number | null {
  const raw = data[key];
  if (typeof raw !== "string") return null;
  const m = /(-?\d+(?:\.\d+)?)\s+(?:hunting|racing)\s+skill/i.exec(raw);
  return m ? Number(m[1]) : null;
}

export function isDomainCategory(category: string): boolean {
  const c = category.toLowerCase();
  return c === "hunting" || c === "missions" || c === "racing" || c === "bounties" || c === "education";
}

/**
 * Normalize one raw domain log into a DomainActivity. Returns null when the
 * (category, title, payload) is not a recognized family — the caller leaves
 * it on the timeline and never fabricates semantics.
 */
export function normalizeDomainLog(category: string, title: string, data: LogRecord): DomainActivity | null {
  const t = title.toLowerCase();
  const c = category.toLowerCase();

  // --- hunting ---
  if (c === "hunting" && t === "hunting") {
    const cost = num(data, "cost");
    const income = num(data, "income");
    if (cost === null && income === null) return null;
    const sessionType = typeof data.session_type === "string" ? data.session_type : "";
    const sessionMatch = /\b(beginners|standard|advanced)\b/i.exec(sessionType);
    return {
      domain: "hunting", activityType: "hunting", activityLabel: "Hunting",
      subtype: sessionMatch ? sessionMatch[1]!.toLowerCase() : sessionType || null,
      outcome: "completed", opponentId: null,
      cashInput: cost, cashReward: income, pointsReward: null, tokensReward: null,
      netValue: income !== null && cost !== null ? income - cost : (income ?? -cost!),
      valuation: "exact", provenance: "exact",
    };
  }
  if (c === "hunting" && t === "hunting skill level up") {
    const level = int(data, "skill_level");
    if (level === null) return null;
    return {
      domain: "hunting", activityType: "hunting", activityLabel: "Hunting",
      subtype: "skill-level-up", outcome: "progressed", opponentId: null,
      cashInput: null, cashReward: null, pointsReward: null, tokensReward: null,
      netValue: null, valuation: "unpriced", provenance: "exact",
    };
  }

  // --- missions ---
  if (c === "missions" && t === "missions complete") {
    const money = num(data, "money");
    const credits = int(data, "credits");
    if (money === null && credits === null) return null;
    const type = typeof data.type === "string" && data.type !== "" ? data.type : null;
    return {
      domain: "missions", activityType: "missions", activityLabel: "Missions",
      subtype: type, outcome: "completed", opponentId: null,
      cashInput: null, cashReward: money, pointsReward: null,
      tokensReward: credits, // mission credits (unit = missions domain)
      netValue: money, valuation: "exact", provenance: "exact",
    };
  }

  // --- racing ---
  if (c === "racing" && t === "racing finish official race") {
    const positionRaw = typeof data.position === "string" ? data.position.trim().toLowerCase() : null;
    if (positionRaw === null && num(data, "cost") === null && data.racing_points === undefined) return null;
    const pointsMatch = typeof data.racing_points === "string"
      ? /^\s*(\d+)\s+racing\s+points?\s*$/i.exec(data.racing_points)
      : null;
    const points = pointsMatch ? Number(pointsMatch[1]) : null;
    const outcome = positionRaw === "1st" ? "win" : positionRaw === "2nd" || positionRaw === "3rd" ? "podium" : positionRaw !== null ? "finished" : null;
    return {
      domain: "racing", activityType: "racing", activityLabel: "Racing",
      subtype: "official-finish", outcome, opponentId: null,
      cashInput: null, cashReward: null, pointsReward: points, tokensReward: null,
      netValue: null, valuation: "unpriced", provenance: "exact",
    };
  }
  if (c === "racing" && t === "racing upgrade car") {
    const cost = num(data, "cost");
    if (cost === null) return null;
    const pointsMatch = typeof data.racing_points === "string"
      ? /^\s*(\d+)\s+racing\s+points?\s*$/i.exec(data.racing_points)
      : null;
    return {
      domain: "racing", activityType: "racing", activityLabel: "Racing",
      subtype: "upgrade", outcome: "upgraded", opponentId: null,
      cashInput: cost, cashReward: null,
      pointsReward: pointsMatch ? Number(pointsMatch[1]) : null, tokensReward: null,
      netValue: -cost, valuation: "exact", provenance: "exact",
    };
  }

  // --- bounties ---
  if (c === "bounties" && t === "bounty place") {
    const cost = num(data, "cost");
    const reward = num(data, "bounty_reward");
    if (cost === null && reward === null) return null;
    const target = int(data, "target");
    return {
      domain: "bounties", activityType: "bounties", activityLabel: "Bounties",
      subtype: "placed", outcome: "placed", opponentId: target,
      cashInput: cost, cashReward: null, pointsReward: null, tokensReward: null,
      // Placing a bounty is a committed spend, not a pending stake.
      netValue: cost !== null ? -cost : null,
      valuation: "exact", provenance: "exact",
    };
  }
  if (c === "bounties" && t === "bounty claim") {
    const reward = num(data, "bounty_reward");
    if (reward === null) return null;
    const target = int(data, "target");
    return {
      domain: "bounties", activityType: "bounties", activityLabel: "Bounties",
      subtype: "claimed", outcome: "claimed", opponentId: target,
      cashInput: null, cashReward: reward, pointsReward: null, tokensReward: null,
      netValue: reward, valuation: "exact", provenance: "exact",
    };
  }

  // --- education ---
  if (c === "education" && t === "education start") {
    const cost = num(data, "cost");
    if (cost === null) return null;
    return {
      domain: "education", activityType: "education", activityLabel: "Education",
      subtype: "course-started", outcome: "started", opponentId: null,
      cashInput: cost, cashReward: null, pointsReward: null, tokensReward: null,
      netValue: -cost, valuation: "exact", provenance: "exact",
    };
  }

  return null;
}

/** Metadata stored on the ActivityEvent: the raw payload with parsed
 *  progression extras merged in (raw keys untouched, parsed numeric
 *  siblings added so services can aggregate skill trajectories without
 *  string parsing in SQL). */
export function buildDomainMetadata(category: string, title: string, data: LogRecord): Record<string, unknown> {
  const c = category.toLowerCase();
  const t = title.toLowerCase();
  const extras: Record<string, unknown> = {};
  if (c === "hunting" && t === "hunting") {
    const skill = typeof data.hunting_skill === "string" && data.hunting_skill !== "" ? Number(data.hunting_skill) : null;
    if (skill !== null && Number.isFinite(skill)) extras.skillLevel = skill;
    const gain = skillGain(data, "hunting_skill_gain");
    if (gain !== null) extras.skillGain = gain;
  }
  if (c === "racing" && t === "racing finish official race") {
    const gain = skillGain(data, "racing_skill");
    if (gain !== null) extras.racingSkillGain = gain;
  }
  return { ...data, ...extras };
}
