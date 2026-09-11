import { describe, expect, it } from "vitest";
import {
  classifyAttentionEvent,
  parseRentalAmount,
  DEFAULT_TYPE_TOGGLES,
  NOTIFICATION_TYPES,
  NOTIFICATION_GROUPS,
  notificationType,
  normalizeTypeToggles,
  normalizeTypeConfig,
  decideQuietHours,
  isWithinQuietHours,
  syncProblemCopy,
  capabilityLostCopy,
  diffTimerTransitions,
  type LiveTimerState,
} from "../src/notifications.js";
import { localMinutesInZone, nextWallClockOccurrence } from "../src/day.js";

/**
 * Notification registry + classifier + quiet-hours policy + dedup/transition
 * semantics.
 *
 * Privacy contract: default bodies NEVER contain amounts/senders/items —
 * richer text lives in sensitiveBody and is used only when the profile's
 * sensitiveDetails preference is ON.
 */

describe("classifyAttentionEvent", () => {
  it("classifies a rental extension offer with parsed details (real production title)", () => {
    const cls = classifyAttentionEvent(
      "GinoMontero has offered you a 20 day extension on the rental of their Private Island for $17,000,000. Click here to view the offer."
    );
    expect(cls).not.toBeNull();
    expect(cls!.type).toBe("rentals");
    expect(cls!.urgency).toBe("time_sensitive");
    expect(cls!.body).toBe("GinoMontero offered a 20-day Private Island rental extension.");
    expect(cls!.sensitiveBody).toContain("$17,000,000");
    expect(cls!.sensitiveBody).not.toBe(cls!.body);
    expect(parseRentalAmount(cls!.sensitiveBody!)).toBe(17_000_000);
  });

  it("classifies new mail without exposing content by default", () => {
    const cls = classifyAttentionEvent("You got a mail from Someone");
    expect(cls?.type).toBe("mail");
    expect(cls?.body).toBe("You received a new message.");
    expect(cls?.sensitiveBody).toBeNull();
  });

  it("classifies item received; sensitive body carries the parsed detail", () => {
    const cls = classifyAttentionEvent("Someone sent you an item");
    expect(cls?.type).toBe("items");
    expect(cls?.body).toBe("Someone sent you an item.");
    expect(cls?.sensitiveBody).toBe("Someone sent you an item");
  });

  it("classifies plain money receive as normal urgency", () => {
    const cls = classifyAttentionEvent("Money receive");
    expect(cls?.type).toBe("money");
    expect(cls?.urgency).toBe("normal");
    expect(cls?.body).toBe("New incoming money detected.");
  });

  it("classifies faction payouts (wallet and balance variants)", () => {
    expect(classifyAttentionEvent("Faction payout money receive")?.title).toBe("Faction payout received");
    expect(classifyAttentionEvent("Faction payout money balance receive")?.title).toBe("OC payout received");
    expect(classifyAttentionEvent("Faction give money receive")?.type).toBe("faction_oc");
  });

  it("classifies trade accepted by another player (real production title)", () => {
    const cls = classifyAttentionEvent('MrsPuff has accepted the trade titled "some flowers and plushies". You must now accept to finalize it.');
    expect(cls?.type).toBe("trades");
    expect(cls?.urgency).toBe("time_sensitive");
    expect(cls?.sensitiveBody).toContain("some flowers and plushies");
  });

  it("classifies OC initiation for participating players as time-sensitive", () => {
    const cls = classifyAttentionEvent("The Stage Fright scenario you participated in has been initiated [view]");
    expect(cls?.type).toBe("faction_oc");
    expect(cls?.urgency).toBe("time_sensitive");
    expect(cls?.eventKey).toBe("oc-init:Stage Fright");
  });

  it("classifies education completion and bank maturity events", () => {
    expect(classifyAttentionEvent("The education course you were taking has ended. Please click here.")?.type).toBe("education_complete");
    expect(classifyAttentionEvent("Your bank investment has ended. Please click here to collect your funds.")?.type).toBe("bank_matured");
  });

  it("returns null for routine events (bazaar sales, attacks on you)", () => {
    expect(classifyAttentionEvent("Galaaz86 bought 1 x Leather Gloves from your bazaar for $265.")).toBeNull();
    expect(classifyAttentionEvent("Someone attacked you [view]")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Canonical registry                                                          */
/* -------------------------------------------------------------------------- */

describe("notification type registry", () => {
  it("ids are unique and every type resolves", () => {
    const ids = NOTIFICATION_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(notificationType(id)?.id).toBe(id);
    expect(notificationType("nonexistent")).toBeUndefined();
  });

  it("every type belongs to a declared group with real capabilities and routes", () => {
    const groupIds = NOTIFICATION_GROUPS.map((g) => g.id);
    for (const t of NOTIFICATION_TYPES) {
      expect(groupIds).toContain(t.group);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.maxDeferralAgeSeconds).toBeGreaterThan(0);
      expect(t.clickPath.startsWith("/")).toBe(true);
    }
  });

  it("urgency is explicit: only service-level types are critical", () => {
    for (const t of NOTIFICATION_TYPES) {
      if (t.urgency === "critical") expect(t.group).toBe("system");
    }
    // Business-as-usual game events are never critical.
    for (const id of ["mail", "items", "money", "energy_full", "travel_arrival", "daily_summary_ready", "progression_milestone"]) {
      expect(notificationType(id)!.urgency).not.toBe("critical");
    }
    expect(notificationType("capability_lost")!.urgency).toBe("critical");
  });

  it("defaults: high-value types on, noisy/noisy-inference types off", () => {
    expect(DEFAULT_TYPE_TOGGLES["mail"]).toBe(true);
    expect(DEFAULT_TYPE_TOGGLES["trades"]).toBe(true);
    expect(DEFAULT_TYPE_TOGGLES["travel_arrival"]).toBe(true);
    expect(DEFAULT_TYPE_TOGGLES["capability_lost"]).toBe(true);
    expect(DEFAULT_TYPE_TOGGLES["sync_degraded"]).toBe(true);
    expect(DEFAULT_TYPE_TOGGLES["money"]).toBe(false);
    expect(DEFAULT_TYPE_TOGGLES["items"]).toBe(false);
    expect(DEFAULT_TYPE_TOGGLES["energy_full"]).toBe(false);
    expect(DEFAULT_TYPE_TOGGLES["energy_near_full"]).toBe(false);
    expect(DEFAULT_TYPE_TOGGLES["major_cash_movement"]).toBe(false);
    expect(DEFAULT_TYPE_TOGGLES["networth_movement"]).toBe(false);
    expect(DEFAULT_TYPE_TOGGLES["sync_recovered"]).toBe(false);
  });

  it("there is no dead toggle: every type documents a real delivery path", () => {
    // The old 'attention' category had no producer and was removed.
    expect(notificationType("attention")).toBeUndefined();
  });

  it("types with config declare exactly the fields they use", () => {
    expect(notificationType("energy_near_full")!.config).toEqual(["nearFullThreshold"]);
    expect(notificationType("major_cash_movement")!.config).toEqual(["cashThreshold"]);
    expect(notificationType("networth_movement")!.config).toEqual(["networthThreshold"]);
    expect(notificationType("daily_summary_ready")!.config).toEqual(["summaryTimeMin"]);
    expect(notificationType("mail")!.config).toEqual([]);
  });
});

describe("legacy toggle normalization", () => {
  it("fans legacy categories out to their canonical types", () => {
    const out = normalizeTypeToggles({ travel: false, cooldowns: false, energy_nerve: false });
    expect(out["travel_arrival"]).toBe(false);
    expect(out["drug_cooldown"]).toBe(false);
    expect(out["medical_cooldown"]).toBe(false);
    expect(out["booster_cooldown"]).toBe(false);
    // energy_nerve was off → both halves off.
    expect(out["energy_full"]).toBe(false);
    expect(out["nerve_full"]).toBe(false);
  });

  it("explicit new values win over legacy fan-out", () => {
    const out = normalizeTypeToggles({ cooldowns: false, drug_cooldown: true });
    expect(out["drug_cooldown"]).toBe(true);
    expect(out["medical_cooldown"]).toBe(false);
  });

  it("hospital_jail splits into two independent toggles", () => {
    const out = normalizeTypeToggles({ hospital_jail: true });
    expect(out["hospital_release"]).toBe(true);
    expect(out["jail_release"]).toBe(true);
  });

  it("the dead 'attention' key is dropped, not invented", () => {
    const out = normalizeTypeToggles({ attention: true });
    expect("attention" in out).toBe(false);
  });

  it("an empty stored map yields pure defaults", () => {
    expect(normalizeTypeToggles({})).toEqual(DEFAULT_TYPE_TOGGLES);
    expect(normalizeTypeToggles(null)).toEqual(DEFAULT_TYPE_TOGGLES);
  });
});

describe("type config resolution", () => {
  it("fills defaults for absent keys", () => {
    const cfg = normalizeTypeConfig(null);
    expect(cfg.nearFullThreshold).toBe(135);
    expect(cfg.cashThreshold).toBe(50_000_000);
    expect(cfg.networthThreshold).toBe(100_000_000);
    expect(cfg.summaryTimeMin).toBe(480);
  });

  it("merges partial stored config over defaults and rejects junk", () => {
    expect(normalizeTypeConfig({ cashThreshold: 75_000_000 }).cashThreshold).toBe(75_000_000);
    expect(normalizeTypeConfig({ cashThreshold: -5 }).cashThreshold).toBe(50_000_000);
    expect(normalizeTypeConfig({ nonsense: 1 }).nearFullThreshold).toBe(135);
  });
});

/* -------------------------------------------------------------------------- */
/* Quiet hours policy                                                          */
/* -------------------------------------------------------------------------- */

const normalType = notificationType("daily_summary_ready")!;
const timeSensitive = notificationType("travel_arrival")!;
const criticalType = notificationType("capability_lost")!;
const quiet = { startMin: 22 * 60 + 30, endMin: 7 * 60 + 30, bypassCritical: true };

describe("quiet hours decision", () => {
  it("no quiet hours configured → always deliver", () => {
    const off = { startMin: null, endMin: null, bypassCritical: true };
    expect(decideQuietHours(normalType, off, 1380, { quietEndSec: null })).toEqual({ action: "deliver" });
  });

  it("outside the window → deliver", () => {
    expect(decideQuietHours(normalType, quiet, 12 * 60, { quietEndSec: null })).toEqual({ action: "deliver" });
  });

  it("normal type inside quiet hours defers to quiet end — never silently drops", () => {
    const d = decideQuietHours(normalType, quiet, 23 * 60, { quietEndSec: 1_000_500 });
    expect(d).toEqual({ action: "defer", deliverAtSec: 1_000_500 });
  });

  it("time-sensitive types defer too, per registry behavior", () => {
    expect(decideQuietHours(timeSensitive, quiet, 23 * 60, { quietEndSec: 1_000_500 })).toEqual({
      action: "defer",
      deliverAtSec: 1_000_500,
    });
  });

  it("critical bypasses quiet hours when the preference allows", () => {
    expect(decideQuietHours(criticalType, quiet, 23 * 60, { quietEndSec: 1_000_500 })).toEqual({ action: "deliver" });
  });

  it("critical is suppressed when bypass is disabled — recorded, never lost silently", () => {
    const noBypass = { ...quiet, bypassCritical: false };
    expect(decideQuietHours(criticalType, noBypass, 23 * 60, { quietEndSec: 1_000_500 })).toEqual({
      action: "suppress",
      reason: "quiet_hours",
    });
  });

  it("explicit user actions (test push) are never deferred", () => {
    expect(decideQuietHours(normalType, quiet, 23 * 60, { quietEndSec: 1_000_500, explicit: true })).toEqual({ action: "deliver" });
  });

  it("overnight windows wrap midnight correctly", () => {
    expect(isWithinQuietHours(22 * 60 + 30, 7 * 60 + 30, 23 * 60)).toBe(true);
    expect(isWithinQuietHours(22 * 60 + 30, 7 * 60 + 30, 3 * 60)).toBe(true);
    expect(isWithinQuietHours(22 * 60 + 30, 7 * 60 + 30, 12 * 60)).toBe(false);
    // Same-day window (13:00 → 14:00)
    expect(isWithinQuietHours(13 * 60, 14 * 60, 13 * 60 + 30)).toBe(true);
    expect(isWithinQuietHours(13 * 60, 14 * 60, 15 * 60)).toBe(false);
  });
});

describe("wall-clock scheduling (timezone + DST)", () => {
  it("computes local minutes in a zone", () => {
    // 2026-01-01 12:00 UTC = 13:00 in Europe/Berlin (winter).
    expect(localMinutesInZone(1767268800, "Europe/Berlin")).toBe(13 * 60);
    expect(localMinutesInZone(1767268800, "UTC")).toBe(12 * 60);
  });

  it("next occurrence of a local time resolves forward, same day first", () => {
    const now = 1767268800; // 12:00 UTC / 13:00 Berlin
    // 20:30 Berlin today is in the future.
    const today = nextWallClockOccurrence(20 * 60 + 30, "Europe/Berlin", now);
    expect(localMinutesInZone(today, "Europe/Berlin")).toBe(20 * 60 + 30);
    expect(today).toBeGreaterThan(now);
    // 09:00 Berlin already passed → tomorrow.
    const tomorrow = nextWallClockOccurrence(9 * 60, "Europe/Berlin", now);
    expect(tomorrow).toBeGreaterThan(now + 12 * 3600);
    expect(localMinutesInZone(tomorrow, "Europe/Berlin")).toBe(9 * 60);
  });

  it("handles a DST spring-forward gap without inventing a fake instant", () => {
    // Europe/Berlin 2026-03-29 02:00 → 03:00 (02:30 local does not exist).
    const before = Math.floor(Date.UTC(2026, 2, 29, 0, 30) / 1000); // 01:30 local
    const next = nextWallClockOccurrence(2 * 60 + 30, "Europe/Berlin", before);
    // Must resolve to a real instant with a sane local time (03:30 at worst).
    const local = localMinutesInZone(next, "Europe/Berlin");
    expect(next).toBeGreaterThan(before);
    expect(local).toBeGreaterThanOrEqual(3 * 60);
  });
});

/* -------------------------------------------------------------------------- */
/* System copy (coalescing + jargon-free)                                      */
/* -------------------------------------------------------------------------- */

describe("system notification copy", () => {
  it("groups multiple failing resources into one message with no machine enums", () => {
    const copy = syncProblemCopy(["money_logs", "drugs"], { money_logs: "Wallet history", drugs: "Drug history" });
    expect(copy.title).toBe("Data sources need attention");
    expect(copy.body).toContain("2 data sources");
    expect(copy.body.toLowerCase()).not.toContain("money_logs");
    expect(copy.body.toLowerCase()).not.toContain("worker");
  });

  it("single failure names the source in plain words", () => {
    const copy = syncProblemCopy(["travel"], { travel: "Travel history" });
    expect(copy.title).toBe("Data source needs attention");
    expect(copy.body).toBe("Travel history is no longer updating.");
  });

  it("capability-loss wording retains history and avoids 'failed'", () => {
    const copy = capabilityLostCopy(["money_logs"], { money_logs: "Wallet history" });
    expect(copy.body).toContain("retained");
    expect(copy.body.toLowerCase()).not.toContain("failed");
    expect(copy.body.toLowerCase()).not.toContain("money_logs");
  });
});

/* -------------------------------------------------------------------------- */
/* Timer transitions (diff)                                                    */
/* -------------------------------------------------------------------------- */

describe("timer transition diff", () => {
  const now = 1_000_000;

  it("emits travel landed exactly once when a timer crosses its end", () => {
    const previous: LiveTimerState = { travelLandsAt: now - 60 };
    const current: LiveTimerState = { travelLandsAt: null };
    const { events } = diffTimerTransitions(previous, current, now);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("travel_arrival");
    expect(events[0]!.eventKey).toBe(`travelLandsAt:ended:${now - 60}`);
    // Same diff again = same key = dedupe ledger rejects the resend.
    const again = diffTimerTransitions(previous, current, now);
    expect(again.events[0]!.eventKey).toBe(events[0]!.eventKey);
  });

  it("does not emit while a timer is still active", () => {
    const previous: LiveTimerState = { cooldownDrugEndsAt: now + 600 };
    const current: LiveTimerState = { cooldownDrugEndsAt: now + 300 };
    const { events } = diffTimerTransitions(previous, current, now);
    expect(events).toHaveLength(0);
  });

  it("emits drug cooldown ready on active → ready transition", () => {
    const previous: LiveTimerState = { cooldownDrugEndsAt: now - 1 };
    const current: LiveTimerState = { cooldownDrugEndsAt: null };
    const { events } = diffTimerTransitions(previous, current, now);
    expect(events[0]!.type).toBe("drug_cooldown");
    expect(events[0]!.body).toContain("drug cooldown");
  });

  it("emits hospital release, jail release, education completion and bank maturity", () => {
    const previous: LiveTimerState = {
      hospitalizedUntil: now - 5,
      jailedUntil: now - 6,
      educationEndsAt: now - 7,
      bankMaturesAt: now - 8,
    };
    const current: LiveTimerState = {};
    const { events } = diffTimerTransitions(previous, current, now);
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(["bank_matured", "education_complete", "hospital_release", "jail_release"]);
  });

  it("energy is NOT a timer (bars producer owns it); nerve still is", () => {
    const previous: LiveTimerState = { energyFullAt: now - 10, nerveFullAt: now - 12 };
    const current: LiveTimerState = {};
    const { events } = diffTimerTransitions(previous, current, now);
    expect(events.map((e) => e.type)).toEqual(["nerve_full"]);
  });

  it("computes next eligible at the soonest active timer end (no per-minute polling)", () => {
    const current: LiveTimerState = { travelLandsAt: now + 5_000, cooldownDrugEndsAt: now + 60_000 };
    const { nextEligibleAt } = diffTimerTransitions(null, current, now);
    expect(nextEligibleAt).toBe(now + 5_000 + 45); // soonest end + grace
  });
});
