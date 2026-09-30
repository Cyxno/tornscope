import {
  buildCooldown,
  buildLiveBar,
  buildUpcomingEvents,
  TORN_ACCESS_LEVELS,
  type BankStatus,
  type CooldownKind,
  type CooldownState,
  type EducationStatus,
  type LiveBar,
  type PlayerStatus,
  type StatusNotice,
  type TodayBarKey,
  type TodayResponse,
  type TravelStatus,
  type UpcomingEvent,
} from "@tornscope/shared";
import type {
  TornEducationCategory,
  TornUserBars,
  TornUserCooldowns,
  TornUserEducation,
  TornUserMoney,
  TornUserProfile,
  TornUserTravel,
} from "@tornscope/torn-api";
import { TornApiError } from "@tornscope/torn-api";
import { normalizeCapabilitiesWithFallback, TtlMap, type KeyCapabilities } from "@tornscope/shared";
import { getApiContext } from "../context.js";
import { errors } from "../errors.js";

/**
 * Today (live status) service.
 *
 * Fetches a handful of Torn selections once per cache window and returns
 * ABSOLUTE timestamps; countdown rendering happens client-side from those
 * timestamps, so the browser never polls per-second and this service never
 * sees more than ~1 request set per TTL window per user.
 *
 * Nothing here is persisted per poll: bar/cooldown ticks have no historical
 * value, and travel / bank / education transitions are already represented by
 * Torn's own logs (preferred as historical truth). The only database read is
 * the latest open TravelEvent, used to name the origin country when flying
 * home — never written.
 */

const CACHE_TTL_MS = Number(process.env.TODAY_CACHE_TTL_MS ?? 30_000);
const EDUCATION_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

// TTL-bounded (TtlMap): a user who never returns is eventually swept, so the
// map cannot grow with one-time visitors. The 5_000-entry ceiling is an
// emergency bound, not a tuning knob — 5k concurrent live payloads (~KBs
// each) is orders of magnitude beyond any single-node deployment; eviction
// order is expired-first, then oldest, so active users are never evicted.
// Sweeps are lazy (at most one per 64 writes) — no timers, no per-request cost.
const cache = new TtlMap<Promise<TodayResponse>>({
  ttlMs: CACHE_TTL_MS,
  maxEntries: 5_000,
  sweepEvery: 64,
});
const refreshInFlight = new Map<string, Promise<TodayResponse>>();

let educationCatalog: { fetchedAt: number; byCourseId: Map<number, { name: string; category: string }> } | null = null;

/** Test seam: drop the in-process education catalog cache. */
export function clearEducationCatalogCache(): void {
  educationCatalog = null;
}

/**
 * GET /api/today — STALE-WHILE-REVALIDATE (real-user remediation: cold page
 * loads used to block on 6-7 serialized upstream Torn calls).
 *
 * Order of preference:
 *  1. fresh in-memory cache → returned immediately;
 *  2. persisted last-known payload → returned IMMEDIATELY (marked `stale`
 *     once older than the cache window) while a single-flight background
 *     refresh revalidates — the UI shows real data plus a freshness marker
 *     instead of a blocking skeleton;
 *  3. nothing persisted (first ever load) → await the refresh, persist it.
 *
 * The persisted copy carries its original fetchedAt — stale data is never
 * presented as current. Background failures never evict last-known. Demo
 * users get deterministic simulated live data (no Torn, no persistence).
 */
export async function getToday(user: { id: string; isDemo: boolean }): Promise<TodayResponse> {
  const now = Date.now();
  const cached = cache.get(user.id);
  if (cached) return cached;

  if (user.isDemo) {
    const promise = Promise.resolve(buildDemoToday());
    cache.set(user.id, promise);
    return promise;
  }

  const lastKnown = await readLastKnown(user.id, now);
  if (lastKnown) {
    // Serve the persisted copy for this cache window; revalidate once in the
    // background. The served promise is already resolved — a burst of cold
    // requests is never queued behind the upstream fetch.
    cache.set(user.id, Promise.resolve(lastKnown));
    startBackgroundRefresh(user);
    return lastKnown;
  }

  const pending = refreshInFlight.get(user.id);
  if (pending) return pending;

  const refresh = startRefresh(user);
  return refresh;
}

/** One upstream refresh at a time per user; success persists + repopulates
 *  the in-memory cache, failure evicts the single-flight entry only. */
function startRefresh(user: { id: string }): Promise<TodayResponse> {
  const promise = fetchToday(user.id)
    .then(async (res) => {
      refreshInFlight.delete(user.id);
      cache.set(user.id, Promise.resolve(res));
      await persistLastKnown(user.id, res).catch(() => undefined);
      return res;
    })
    .catch((err) => {
      refreshInFlight.delete(user.id);
      throw err;
    });
  refreshInFlight.set(user.id, promise);
  return promise;
}

/** Kick off a revalidation without ever surfacing its failure. */
function startBackgroundRefresh(user: { id: string }): void {
  if (refreshInFlight.has(user.id)) return;
  void startRefresh(user).catch(() => undefined);
}

async function readLastKnown(userId: string, nowMs: number): Promise<TodayResponse | null> {
  try {
    const ctx = getApiContext();
    const row = await ctx.db.todayLastKnown.findUnique({ where: { userId } });
    if (!row) return null;
    const payload = row.payload as TodayResponse;
    // Stale the moment the copy is older than one cache window — never
    // present old data as current.
    return { ...payload, stale: nowMs - row.fetchedAt.getTime() > CACHE_TTL_MS };
  } catch {
    // Persistence is an optimization; live fetch semantics survive without it.
    return null;
  }
}

async function persistLastKnown(userId: string, payload: TodayResponse): Promise<void> {
  const ctx = getApiContext();
  const clean: TodayResponse = { ...payload };
  delete (clean as { stale?: boolean }).stale;
  await ctx.db.todayLastKnown.upsert({
    where: { userId },
    create: { userId, payload: clean as unknown as object, fetchedAt: new Date(payload.fetchedAt) },
    update: { payload: clean as unknown as object, fetchedAt: new Date(payload.fetchedAt) },
  });
}

/* -------------------------------------------------------------------------- */
/* Demo live data (deterministic, time-driven — clearly marked)               */
/* -------------------------------------------------------------------------- */

const DEMO_COURSES = [
  { id: 74, name: "Cognitive Psychology", category: "Bachelor of Psychology" },
  { id: 12, name: "Defensive Driving", category: "Defensive Driving" },
  { id: 31, name: "Self-defense Basics", category: "Self-defense" },
] as const;

/**
 * Simulated live status for the demo player. Everything is a deterministic
 * function of the server clock (no random, no Torn calls): bars fill and
 * reset on fixed cycles, cooldowns clear, flights land, courses complete.
 * Provenance is "estimated" throughout — this is simulation, never a real
 * Torn reading, and it never touches the real user's records.
 */
export function buildDemoToday(nowMs: number = Date.now()): TodayResponse {
  const nowSec = Math.floor(nowMs / 1000);
  const cycle = (period: number) => nowSec % period;
  const bar = (key: TodayBarKey, max: number, period: number): LiveBar =>
    buildLiveBar(nowSec, key, { current: Math.floor(max * (cycle(period) / period)), maximum: max, increment: Math.max(1, Math.round(max / (period / 60))), interval: 60, full_time: nowSec + period - cycle(period) });

  const cooldown = (kind: "drug" | "booster" | "medical", period: number, activeFor: number) =>
    buildCooldown(nowSec, kind, cycle(period) < activeFor ? activeFor - cycle(period) : 0);

  const travelCycle = 3 * 3600;
  const phase = cycle(travelCycle);
  let travel: TravelStatus;
  if (phase < 3600) {
    const landsAt = nowSec + 3600 - phase;
    travel = {
      state: "traveling",
      country: "Argentina",
      direction: "outbound",
      method: "Airliner",
      departedAt: nowSec - phase,
      landsAt,
      remainingSeconds: landsAt - nowSec,
      durationSeconds: 3600,
      provenance: "estimated",
      unavailableReason: null,
      requiredAccess: null,
    };
  } else if (phase < 7200) {
    travel = {
      state: "abroad",
      country: "Argentina",
      direction: null,
      method: "Airliner",
      departedAt: nowSec - (phase - 3600),
      landsAt: null,
      remainingSeconds: null,
      durationSeconds: null,
      provenance: "estimated",
      unavailableReason: null,
      requiredAccess: null,
    };
  } else {
    travel = {
      state: "home",
      country: null,
      direction: null,
      method: "Airliner",
      departedAt: null,
      landsAt: null,
      remainingSeconds: null,
      durationSeconds: null,
      provenance: "estimated",
      unavailableReason: null,
      requiredAccess: null,
    };
  }

  const course = DEMO_COURSES[Math.floor(nowSec / 86_400) % DEMO_COURSES.length] ?? DEMO_COURSES[0];
  const completesAt = nowSec + 6 * 3600 - cycle(6 * 3600);
  const education: EducationStatus = {
    state: "active",
    courseId: course.id,
    courseName: course.name,
    categoryName: course.category,
    completesAt,
    remainingSeconds: completesAt - nowSec,
    provenance: "estimated",
    unavailableReason: null,
    requiredAccess: null,
  };

  const amount = 450_000_000;
  const principal = 400_000_000;
  const profit = amount - principal;
  const maturesAt = nowSec + 10 * 86_400 + (86_400 - cycle(86_400));
  const bank: BankStatus = {
    state: "active",
    amount,
    principal,
    profit,
    returnPct: Math.round((profit / principal) * 100 * 100) / 100,
    annualizedPct: Math.round(((profit / principal) * 100 * 365) / 30 * 10) / 10,
    durationDays: 30,
    investedAt: nowSec - 20 * 86_400,
    maturesAt,
    remainingSeconds: maturesAt - nowSec,
    provenance: "estimated",
    unavailableReason: null,
    requiredAccess: null,
  };

  const bars = {
    energy: { ...bar("energy", 150, 3600), provenance: "estimated" as const },
    nerve: { ...bar("nerve", 55, 5400), provenance: "estimated" as const },
    happy: { ...bar("happy", 5000, 4500), provenance: "estimated" as const },
    life: { ...bar("life", 4150, 2700), provenance: "estimated" as const },
  };
  const cooldowns = {
    drug: { ...cooldown("drug", 1800, 720), provenance: "estimated" as const },
    booster: { ...cooldown("booster", 10_800, 2700), provenance: "estimated" as const },
    medical: { ...cooldown("medical", 3600, 0), provenance: "estimated" as const },
  };

  const upcoming = buildUpcomingEvents(
    collectUpcoming(nowSec, {
      bars,
      cooldowns,
      travel,
      education,
      bank,
      hospital: null,
      jail: null,
    })
  );

  return {
    fetchedAt: nowMs,
    serverTime: nowSec,
    demo: true,
    player: {
      name: "DEMO_Player",
      level: 42,
      status: { state: "Okay", description: "Okay", details: null, until: null },
    },
    bars,
    cooldowns,
    travel,
    bank,
    education,
    hospital: null,
    jail: null,
    upcoming,
    access: { level: null, type: "demo", note: null },
  };
}

/* -------------------------------------------------------------------------- */
/* Fetch + orchestration                                                      */
/* -------------------------------------------------------------------------- */

/** A section that could not be loaded (access level or transient Torn error). */
export interface SectionFailure {
  kind: "access_denied" | "transient" | "skipped";
  message: string | null;
  requiredAccess: string | null;
}

export function isSectionFailure(value: unknown): value is SectionFailure {
  return typeof value === "object" && value !== null && "kind" in value && "requiredAccess" in value;
}

function sectionFailure(err: unknown): SectionFailure {
  if (err instanceof TornApiError && err.kind === "access_denied") {
    return { kind: "access_denied", message: null, requiredAccess: null };
  }
  return { kind: "transient", message: (err as Error).message ?? "Torn API error", requiredAccess: null };
}

function skippedFailure(requiredAccess: string): SectionFailure {
  return { kind: "skipped", message: null, requiredAccess };
}

async function fetchToday(userId: string): Promise<TodayResponse> {
  const ctx = getApiContext();
  const credential = await ctx.db.apiCredential.findUnique({ where: { userId } });
  if (!credential || credential.revokedAt) throw errors.noApiKey();

  const torn = ctx.torn(ctx.decryptCredential(credential));
  const accessLevel = credential.accessLevel;

  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // Profile is public; it anchors identity + hospital/jail/travel status.
  let profile: TornUserProfile;
  try {
    profile = await torn.userProfile();
  } catch (err) {
    throw mapProfileError(err);
  }

  // Skip requests the key cannot answer anyway (saves rate budget). The
  // detected per-selection capabilities decide; legacy capability blobs and
  // credentials without stored capabilities fall back to the conservative
  // access-level check for the keys those blobs predate.
  const caps = normalizeCapabilitiesWithFallback(credential.capabilities, accessLevel);
  const capAllowed = (capability: keyof KeyCapabilities | null, fallbackLevel: number): boolean => {
    if (caps) return capability === null ? true : caps[capability];
    return accessLevel === null || accessLevel >= fallbackLevel;
  };
  const canBars = capAllowed("canReadUserBars", TORN_ACCESS_LEVELS.minimal);
  const canCooldowns = capAllowed("canReadUserCooldowns", TORN_ACCESS_LEVELS.minimal);
  const canEducation = capAllowed("canReadUserEducation", TORN_ACCESS_LEVELS.minimal);
  const canTravel = capAllowed("canReadUserTravel", TORN_ACCESS_LEVELS.minimal);
  const canMoney = capAllowed("canReadUserMoney", TORN_ACCESS_LEVELS.limited);

  const [bars, cooldowns, education, travel, money] = await Promise.all([
    canBars ? torn.userBars().catch(sectionFailure) : Promise.resolve(skippedFailure("User Bars")),
    canCooldowns ? torn.userCooldowns().catch(sectionFailure) : Promise.resolve(skippedFailure("User Cooldowns")),
    canEducation ? torn.userEducation().catch(sectionFailure) : Promise.resolve(skippedFailure("User Education")),
    canTravel ? torn.userTravel().catch(sectionFailure) : Promise.resolve(skippedFailure("User Travel")),
    canMoney ? torn.userMoney().catch(sectionFailure) : Promise.resolve(skippedFailure("User Money")),
  ]);

  const notes: string[] = [];
  const note = (failure: SectionFailure, section: string, access: string) => {
    if (failure.kind !== "transient") notes.push(`${section} requires ${failure.requiredAccess ?? access} API access.`);
  };

  const barSet: Record<TodayBarKey, LiveBar> | null = isSectionFailure(bars) ? null : assembleBars(nowSec, bars);
  if (isSectionFailure(bars)) note(bars, "bars", "User Bars");

  const cooldownMap: Record<CooldownKind, CooldownState> | null = isSectionFailure(cooldowns)
    ? null
    : assembleCooldowns(nowSec, cooldowns);
  if (isSectionFailure(cooldowns)) note(cooldowns, "cooldowns", "User Cooldowns");

  const educationStatus: EducationStatus = isSectionFailure(education)
    ? educationUnavailable(education)
    : await assembleEducation(nowSec, education, torn);
  if (isSectionFailure(education)) note(education, "education", "User Education");

  const travelValue = isSectionFailure(travel) ? null : travel;
  const travelFailure = isSectionFailure(travel) ? travel : null;
  let openTrip: { destination: string; departedAt: Date } | null = null;
  let travelSyncedAtSec: number | null = null;
  try {
    const [openTripRow, travelSyncRow] = await Promise.all([
      ctx.db.travelEvent.findFirst({
        where: { userId, returnedAt: null },
        orderBy: { departedAt: "desc" },
        select: { destination: true, departedAt: true },
      }),
      // Travel-specific freshness (2.0.6): the worker's last successful
      // travel sync — independent of the whole-payload fetchedAt.
      ctx.db.syncState.findUnique({ where: { userId_resource: { userId, resource: "travel" } }, select: { lastSuccessAt: true } }),
    ]);
    openTrip = openTripRow;
    travelSyncedAtSec = travelSyncRow?.lastSuccessAt ? Math.floor(travelSyncRow.lastSuccessAt.getTime() / 1000) : null;
  } catch {
    // History is optional context; live state still works without it.
  }
  const travelStatus = assembleTravel(nowSec, profile, travelValue, travelFailure, openTrip);
  travelStatus.syncedAt = travelSyncedAtSec;
  if (travelFailure) note(travelFailure, "travel", "User Travel");

  const bankStatus: BankStatus = isSectionFailure(money) ? bankUnavailable(money) : assembleBank(nowSec, money);
  if (isSectionFailure(money)) note(money, "bank", "User Money");

  const status = toPlayerStatus(profile);
  const hospital = extractNotice(nowSec, status, "hospital");
  const jail = extractNotice(nowSec, status, "jail");

  const upcoming = buildUpcomingEvents(
    collectUpcoming(nowSec, {
      bars: barSet,
      cooldowns: cooldownMap,
      travel: travelStatus,
      education: educationStatus,
      bank: bankStatus,
      hospital,
      jail,
    })
  );

  return {
    fetchedAt: nowMs,
    serverTime: nowSec,
    demo: false,
    player: {
      name: profile.profile.name ?? null,
      level: profile.profile.level ?? null,
      status,
    },
    bars: {
      energy: barSet?.energy ?? null,
      nerve: barSet?.nerve ?? null,
      happy: barSet?.happy ?? null,
      life: barSet?.life ?? null,
    },
    cooldowns: {
      drug: cooldownMap?.drug ?? null,
      booster: cooldownMap?.booster ?? null,
      medical: cooldownMap?.medical ?? null,
    },
    travel: travelStatus,
    bank: bankStatus,
    education: educationStatus,
    hospital,
    jail,
    upcoming,
    access: {
      level: accessLevel,
      type: credential.accessType,
      note: notes.length > 0 ? notes.join(" ") : null,
    },
  };
}

function mapProfileError(err: unknown): Error {
  if (err instanceof TornApiError && err.kind === "access_denied") {
    return errors.accessDenied("This key does not grant the public access needed for live status.");
  }
  return errors.tornUnavailable((err as Error).message ?? "Unknown Torn API error");
}

/* -------------------------------------------------------------------------- */
/* Section assembly (exported for tests)                                      */
/* -------------------------------------------------------------------------- */

export function assembleBars(nowSec: number, torn: TornUserBars): Record<TodayBarKey, LiveBar> {
  const b = torn.bars;
  return {
    energy: buildLiveBar(nowSec, "energy", b.energy),
    nerve: buildLiveBar(nowSec, "nerve", b.nerve),
    happy: buildLiveBar(nowSec, "happy", b.happy),
    life: buildLiveBar(nowSec, "life", b.life),
  };
}

export function assembleCooldowns(nowSec: number, torn: TornUserCooldowns): Record<CooldownKind, CooldownState> {
  const c = torn.cooldowns;
  return {
    drug: buildCooldown(nowSec, "drug", c.drug),
    booster: buildCooldown(nowSec, "booster", c.booster),
    medical: buildCooldown(nowSec, "medical", c.medical),
  };
}

/**
 * Torn timestamps arrive as unix seconds, but defensive shapes exist: some
 * key vintages report education/bank end times as milliseconds or as
 * seconds-remaining. Normalize all three deterministically.
 */
export function normalizeTornTimestamp(value: number, nowSec: number): number {
  if (value >= 4e9) return Math.floor(value / 1000); // ms timestamp
  if (value >= 1e9) return value; // unix seconds timestamp
  return nowSec + value; // seconds remaining
}

export async function assembleEducation(
  nowSec: number,
  torn: TornUserEducation,
  tornEndpoints: { tornEducationCatalog(): Promise<TornEducationCategory[]> }
): Promise<EducationStatus> {
  const current = torn.education.current;
  if (!current) {
    return emptyEducation("none");
  }

  const completesAt = normalizeTornTimestamp(current.until, nowSec);
  const entry = (await loadEducationCatalog(tornEndpoints)).get(current.id);

  return {
    state: completesAt <= nowSec ? "complete" : "active",
    courseId: current.id,
    courseName: entry?.name ?? null,
    categoryName: entry?.category ?? null,
    completesAt,
    remainingSeconds: Math.max(0, completesAt - nowSec),
    provenance: "exact",
    unavailableReason: null,
    requiredAccess: null,
  };
}

function emptyEducation(state: EducationStatus["state"]): EducationStatus {
  return {
    state,
    courseId: null,
    courseName: null,
    categoryName: null,
    completesAt: null,
    remainingSeconds: null,
    provenance: "exact",
    unavailableReason: null,
    requiredAccess: null,
  };
}

/** Course id -> { name, category }, cached in-process for a day. */
async function loadEducationCatalog(
  tornEndpoints: { tornEducationCatalog(): Promise<TornEducationCategory[]> }
): Promise<Map<number, { name: string; category: string }>> {
  if (educationCatalog && Date.now() - educationCatalog.fetchedAt < EDUCATION_CATALOG_TTL_MS) {
    return educationCatalog.byCourseId;
  }
  try {
    const categories = await tornEndpoints.tornEducationCatalog();
    const byCourseId = new Map<number, { name: string; category: string }>();
    for (const category of categories) {
      for (const course of category.courses) {
        byCourseId.set(course.id, { name: course.name, category: category.name });
      }
    }
    educationCatalog = { fetchedAt: Date.now(), byCourseId };
    return byCourseId;
  } catch {
    // The catalog only labels the course; the timer works without it.
    return educationCatalog?.byCourseId ?? new Map();
  }
}

export function assembleTravel(
  nowSec: number,
  profile: TornUserProfile,
  travel: TornUserTravel | null,
  travelFailure: SectionFailure | null,
  openTrip: { destination: string; departedAt: Date } | null
): TravelStatus {
  if (travelFailure) {
    return {
      state: "unavailable",
      country: null,
      direction: null,
      method: null,
      departedAt: null,
      landsAt: null,
      remainingSeconds: null,
      durationSeconds: null,
      provenance: "exact",
      unavailableReason: travelFailure.kind === "transient" ? travelFailure.message : null,
      requiredAccess: travelFailure.kind === "transient" ? null : travelFailure.requiredAccess ?? "Minimal",
    };
  }

  const status = profile.profile.status;
  const statusState = status?.state ?? "Okay";
  const destination = travel?.travel.destination ?? "Torn";
  const abroad = destination !== "Torn";

  if (statusState === "Traveling") {
    // While flying home Torn reports destination "Torn"; outbound flights
    // report the target country.
    const returning = !abroad;
    const landsAt = pickTimestamp(status?.until, travel?.travel.arrival_at, travel?.travel.time_left ? nowSec + travel.travel.time_left : null);
    const departedAt = pickTimestamp(travel?.travel.departed_at, openTrip ? openTrip.departedAt.getTime() / 1000 : null);
    return {
      state: "traveling",
      country: returning ? openTrip?.destination ?? null : destination,
      direction: returning ? "returning" : "outbound",
      method: travel?.travel.method ?? null,
      departedAt,
      landsAt,
      remainingSeconds: landsAt !== null ? Math.max(0, landsAt - nowSec) : null,
      durationSeconds: departedAt !== null && landsAt !== null ? Math.max(0, landsAt - departedAt) : null,
      provenance: "exact",
      unavailableReason: null,
      requiredAccess: null,
    };
  }

  if (statusState === "Abroad" && abroad) {
    return {
      state: "abroad",
      country: destination,
      direction: null,
      method: travel?.travel.method ?? null,
      departedAt: pickTimestamp(travel?.travel.departed_at),
      landsAt: null,
      remainingSeconds: null,
      durationSeconds: null,
      provenance: "exact",
      unavailableReason: null,
      requiredAccess: null,
    };
  }

  return {
    state: "home",
    country: null,
    direction: null,
    method: travel?.travel.method ?? null,
    departedAt: null,
    landsAt: null,
    remainingSeconds: null,
    durationSeconds: null,
    provenance: "exact",
    unavailableReason: null,
    requiredAccess: null,
  };
}

export function assembleBank(nowSec: number, money: TornUserMoney): BankStatus {
  const city = money.money.city_bank;
  if (!city || city.amount <= 0) {
    return {
      state: "none",
      amount: null,
      principal: null,
      profit: null,
      returnPct: null,
      annualizedPct: null,
      durationDays: null,
      investedAt: null,
      maturesAt: null,
      remainingSeconds: null,
      provenance: "exact",
      unavailableReason: null,
      requiredAccess: null,
    };
  }

  // Principal = payout value minus exact projected profit. Verified against
  // the money ledger: "Bank invest" transfers match amount - profit exactly.
  const principal = city.profit !== null && city.profit < city.amount ? city.amount - city.profit : null;
  const returnPct = principal !== null && principal > 0 && city.profit !== null ? (city.profit / principal) * 100 : null;
  const annualizedPct = returnPct !== null && city.duration > 0 ? (returnPct * 365) / city.duration : null;
  const investedAt = city.invested_at !== null && city.invested_at >= 1e9 ? city.invested_at : null;

  // MATURE / READY TO COLLECT — detected from the ACTUAL Torn response, not
  // just a time comparison: Torn CLEARS `city_bank.until` (null) the moment
  // the term completes while keeping `amount` at the full payout until the
  // user withdraws. The money still sits in the bank, so the investment
  // stays a visible actionable state. (Verified live 2026-09; before this
  // branch the null timestamp failed the money schema and the whole bank
  // section reported "unavailable" — the card silently vanished.)
  if (city.until === null) {
    return {
      state: "mature",
      amount: city.amount,
      principal,
      profit: city.profit,
      returnPct: returnPct !== null ? Math.round(returnPct * 100) / 100 : null,
      annualizedPct: annualizedPct !== null ? Math.round(annualizedPct * 10) / 10 : null,
      durationDays: city.duration,
      investedAt,
      maturesAt: null,
      remainingSeconds: 0,
      provenance: "exact",
      unavailableReason: null,
      requiredAccess: null,
    };
  }

  const maturesAt = normalizeTornTimestamp(city.until, nowSec);
  return {
    state: maturesAt <= nowSec ? "mature" : "active",
    amount: city.amount,
    principal,
    profit: city.profit,
    returnPct: returnPct !== null ? Math.round(returnPct * 100) / 100 : null,
    annualizedPct: annualizedPct !== null ? Math.round(annualizedPct * 10) / 10 : null,
    durationDays: city.duration,
    investedAt,
    maturesAt,
    remainingSeconds: Math.max(0, maturesAt - nowSec),
    provenance: "exact",
    unavailableReason: null,
    requiredAccess: null,
  };
}

/** Map Torn profile.status to the shared PlayerStatus. */
export function toPlayerStatus(profile: TornUserProfile): PlayerStatus {
  const s = profile.profile.status;
  return {
    state: s?.state ?? "Okay",
    description: s?.description ?? null,
    details: s?.details ?? null,
    until: typeof s?.until === "number" && s.until > 0 ? s.until : null,
  };
}

/** Hospital / jail notice from the player status; null when not applicable. */
export function extractNotice(nowSec: number, status: PlayerStatus, kind: "hospital" | "jail"): StatusNotice | null {
  const isHospital = status.state === "Hospital" && kind === "hospital";
  const isJail = (status.state === "Jail" || status.state === "Federal") && kind === "jail";
  if (!isHospital && !isJail) return null;
  return {
    kind,
    reason: status.details ?? status.description ?? null,
    releasedAt: status.until,
    remainingSeconds: status.until !== null ? Math.max(0, status.until - nowSec) : null,
    provenance: "exact",
  };
}

/* -------------------------------------------------------------------------- */
/* Upcoming                                                                   */
/* -------------------------------------------------------------------------- */

export interface UpcomingSources {
  bars: Record<TodayBarKey, LiveBar> | null;
  cooldowns: Record<CooldownKind, CooldownState> | null;
  travel: TravelStatus;
  education: EducationStatus;
  bank: BankStatus;
  hospital: StatusNotice | null;
  jail: StatusNotice | null;
}

/** Merge every future account timer into UpcomingEvent candidates (unsorted). */
export function collectUpcoming(nowSec: number, src: UpcomingSources): UpcomingEvent[] {
  const out: UpcomingEvent[] = [];

  if (src.bars) {
    for (const key of ["energy", "nerve", "happy", "life"] as const) {
      const bar = src.bars[key];
      if (bar.regenState === "regenerating" && bar.fullAt !== null && bar.fullAt > nowSec) {
        out.push({
          id: `bar:${key}`,
          category: "bar",
          title: `${bar.label} full`,
          at: bar.fullAt,
          remainingSeconds: bar.fullAt - nowSec,
          severity: "info",
        });
      }
    }
  }

  if (src.cooldowns) {
    for (const kind of ["drug", "booster", "medical"] as const) {
      const cd = src.cooldowns[kind];
      if (cd.state === "active" && cd.endsAt !== null && cd.endsAt > nowSec) {
        out.push({
          id: `cooldown:${kind}`,
          category: "cooldown",
          title: `${cd.label} ready`,
          at: cd.endsAt,
          remainingSeconds: cd.endsAt - nowSec,
          severity: "success",
        });
      }
    }
  }

  if (src.travel.state === "traveling" && src.travel.landsAt !== null && src.travel.landsAt > nowSec) {
    out.push({
      id: "travel:landing",
      category: "travel",
      title: src.travel.direction === "returning" ? "Return home" : `Land in ${src.travel.country ?? "destination"}`,
      at: src.travel.landsAt,
      remainingSeconds: src.travel.landsAt - nowSec,
      severity: "info",
    });
  }

  if (src.education.state === "active" && src.education.completesAt !== null && src.education.completesAt > nowSec) {
    out.push({
      id: "education:complete",
      category: "education",
      title: src.education.courseName ? `${src.education.courseName} complete` : "Education complete",
      at: src.education.completesAt,
      remainingSeconds: src.education.completesAt - nowSec,
      severity: "success",
    });
  }

  if (src.bank.state === "active" && src.bank.maturesAt !== null && src.bank.maturesAt > nowSec) {
    out.push({
      id: "bank:mature",
      category: "bank",
      title: "Bank investment matures",
      at: src.bank.maturesAt,
      remainingSeconds: src.bank.maturesAt - nowSec,
      severity: "success",
    });
  }

  if (src.hospital && src.hospital.releasedAt !== null && src.hospital.releasedAt > nowSec) {
    out.push({
      id: "status:hospital",
      category: "status",
      title: "Hospital release",
      at: src.hospital.releasedAt,
      remainingSeconds: src.hospital.releasedAt - nowSec,
      severity: "critical",
    });
  }

  if (src.jail && src.jail.releasedAt !== null && src.jail.releasedAt > nowSec) {
    out.push({
      id: "status:jail",
      category: "status",
      title: "Jail release",
      at: src.jail.releasedAt,
      remainingSeconds: src.jail.releasedAt - nowSec,
      severity: "critical",
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Unavailable fallbacks                                                      */
/* -------------------------------------------------------------------------- */

function educationUnavailable(failure: SectionFailure): EducationStatus {
  return {
    ...emptyEducation("unavailable"),
    unavailableReason: failure.kind === "transient" ? failure.message : null,
    requiredAccess: failure.kind === "transient" ? null : failure.requiredAccess ?? "Minimal",
  };
}

function bankUnavailable(failure: SectionFailure): BankStatus {
  return {
    state: "unavailable",
    amount: null,
    principal: null,
    profit: null,
    returnPct: null,
    annualizedPct: null,
    durationDays: null,
    investedAt: null,
    maturesAt: null,
    remainingSeconds: null,
    provenance: "exact",
    unavailableReason: failure.kind === "transient" ? failure.message : null,
    requiredAccess: failure.kind === "transient" ? null : failure.requiredAccess ?? "Limited",
  };
}

/** First defined, positive timestamp among candidates. */
function pickTimestamp(...candidates: Array<number | null | undefined>): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}
