import { describe, expect, it } from "vitest";
import {
  classifyAttentionEvent,
  parseRentalAmount,
  DEFAULT_CATEGORY_STATE,
  NOTIFICATION_CATEGORIES,
  CATEGORY_IMPORTANCE,
  diffTimerTransitions,
  type LiveTimerState,
} from "../src/notifications.js";

/**
 * Notification classifier + dedup/transition semantics.
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
    expect(cls!.category).toBe("rentals");
    expect(cls!.importance).toBe("important");
    expect(cls!.body).toBe("GinoMontero offered a 20-day Private Island rental extension.");
    expect(cls!.sensitiveBody).toContain("$17,000,000");
    expect(cls!.sensitiveBody).not.toBe(cls!.body);
    expect(parseRentalAmount(cls!.sensitiveBody!)).toBe(17_000_000);
  });

  it("classifies new mail without exposing content by default", () => {
    const cls = classifyAttentionEvent("You got a mail from Someone");
    expect(cls?.category).toBe("mail");
    expect(cls?.body).toBe("You received a new message.");
    expect(cls?.sensitiveBody).toBeNull();
  });

  it("classifies item received; sensitive body carries the parsed detail", () => {
    const cls = classifyAttentionEvent("Someone sent you an item");
    expect(cls?.category).toBe("items");
    expect(cls?.body).toBe("Someone sent you an item.");
    expect(cls?.sensitiveBody).toBe("Someone sent you an item");
  });

  it("classifies plain money receive as activity importance", () => {
    const cls = classifyAttentionEvent("Money receive");
    expect(cls?.category).toBe("money");
    expect(cls?.importance).toBe("activity");
    expect(cls?.body).toBe("New incoming money detected.");
  });

  it("classifies faction payouts (wallet and balance variants)", () => {
    expect(classifyAttentionEvent("Faction payout money receive")?.title).toBe("Faction payout received");
    expect(classifyAttentionEvent("Faction payout money balance receive")?.title).toBe("OC payout received");
    expect(classifyAttentionEvent("Faction give money receive")?.category).toBe("faction_oc");
  });

  it("classifies trade accepted by another player (real production title)", () => {
    const cls = classifyAttentionEvent('MrsPuff has accepted the trade titled "some flowers and plushies". You must now accept to finalize it.');
    expect(cls?.category).toBe("trades");
    expect(cls?.importance).toBe("important");
    expect(cls?.sensitiveBody).toContain("some flowers and plushies");
  });

  it("classifies OC initiation for participating players", () => {
    const cls = classifyAttentionEvent("The Stage Fright scenario you participated in has been initiated [view]");
    expect(cls?.category).toBe("faction_oc");
    expect(cls?.eventKey).toBe("oc-init:Stage Fright");
  });

  it("classifies education completion and bank maturity events", () => {
    expect(classifyAttentionEvent("The education course you were taking has ended. Please click here.")?.category).toBe("education");
    expect(classifyAttentionEvent("Your bank investment has ended. Please click here to collect your funds.")?.category).toBe("bank");
  });

  it("returns null for routine events (bazaar sales, attacks on you)", () => {
    expect(classifyAttentionEvent("Galaaz86 bought 1 x Leather Gloves from your bazaar for $265.")).toBeNull();
    expect(classifyAttentionEvent("Someone attacked you [view]")).toBeNull();
  });
});

describe("category defaults", () => {
  it("enables high-value categories and leaves routine/noisy ones off", () => {
    expect(DEFAULT_CATEGORY_STATE["mail"]).toBe(true);
    expect(DEFAULT_CATEGORY_STATE["rentals"]).toBe(true);
    expect(DEFAULT_CATEGORY_STATE["trades"]).toBe(true);
    expect(DEFAULT_CATEGORY_STATE["faction_oc"]).toBe(true);
    expect(DEFAULT_CATEGORY_STATE["travel"]).toBe(true);
    expect(DEFAULT_CATEGORY_STATE["hospital_jail"]).toBe(true);
    expect(DEFAULT_CATEGORY_STATE["attention"]).toBe(true);
    expect(DEFAULT_CATEGORY_STATE["money"]).toBe(false);
    expect(DEFAULT_CATEGORY_STATE["items"]).toBe(false);
    expect(DEFAULT_CATEGORY_STATE["energy_nerve"]).toBe(false);
  });

  it("every declared category has an importance level", () => {
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(CATEGORY_IMPORTANCE[c.id]).toBeDefined();
    }
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
    expect(events[0]!.category).toBe("travel");
    expect(events[0]!.eventKey).toBe(`travelLandsAt:ended:${now - 60}`);
    // Same diff again = same key = dedup ledger rejects the resend.
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
    expect(events[0]!.category).toBe("cooldowns");
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
    const categories = events.map((e) => e.category).sort();
    expect(categories).toEqual(["bank", "education", "hospital_jail", "hospital_jail"]);
  });

  it("computes next eligible at the soonest active timer end (no per-minute polling)", () => {
    const current: LiveTimerState = { travelLandsAt: now + 5_000, cooldownDrugEndsAt: now + 60_000 };
    const { nextEligibleAt } = diffTimerTransitions(null, current, now);
    expect(nextEligibleAt).toBe(now + 5_000 + 45); // soonest end + grace
  });

  it("energy/nerve transitions map to the energy_nerve category", () => {
    const previous: LiveTimerState = { energyFullAt: now - 10, nerveFullAt: now - 12 };
    const current: LiveTimerState = {};
    const { events } = diffTimerTransitions(previous, current, now);
    expect(events.map((e) => e.category)).toEqual(["energy_nerve", "energy_nerve"]);
  });
});
