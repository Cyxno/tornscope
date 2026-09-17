import { describe, expect, it } from "vitest";
import { UserMoneySchema, type TornUserMoney } from "@tornscope/torn-api";
import { assembleBank, normalizeTornTimestamp } from "../src/services/today.js";

/**
 * Bank maturity state machine — regression tests built from the REAL
 * production Torn payload (captured 2026-09-17, /v2/user/money).
 *
 * The live response for a matured-but-uncollected investment is:
 *   city_bank: { amount: 352152800, profit: 8152800, duration: 14,
 *                interest_rate: 41.24, invested_at: 1788451371, until: null }
 *
 * Two production facts drive the contract:
 * 1. Torn CLEARS `until` (null) the moment the term completes — the timer
 *    no longer exists — while `amount` keeps the full payout until the
 *    user withdraws. The money still sits in the bank.
 * 2. Before the fix, `until: z.number()` rejected null → the WHOLE money
 *    section failed → bank state "unavailable" → the Right-now card
 *    silently vanished exactly when attention was needed.
 */

const REAL_MATURE_UNCOLLECTED: Record<string, unknown> = {
  money: {
    points: 1_234,
    wallet: 46_974_434,
    company: 0,
    vault: 0,
    cayman_bank: 0,
    city_bank: {
      amount: 352_152_800,
      profit: 8_152_800,
      duration: 14,
      interest_rate: 41.24,
      invested_at: 1_788_451_371,
      until: null,
    },
    faction: null,
    daily_networth: 0,
  },
};

function moneyWith(cityBank: Record<string, unknown> | null): TornUserMoney {
  return UserMoneySchema.parse({
    money: {
      points: 0,
      wallet: 0,
      company: 0,
      vault: 0,
      cayman_bank: 0,
      city_bank: cityBank,
      faction: null,
      daily_networth: 0,
    },
  });
}

const NOW = 1_789_665_000;
const DAY = 86_400;

describe("UserMoneySchema vs the real matured payload", () => {
  it("accepts the REAL matured-uncollected response (until: null)", () => {
    const parsed = UserMoneySchema.parse(REAL_MATURE_UNCOLLECTED);
    expect(parsed.money.city_bank?.until).toBeNull();
    expect(parsed.money.city_bank?.amount).toBe(352_152_800);
  });
});

describe("assembleBank — the full maturity state machine", () => {
  it("ACTIVE >7d: investment renders with a countdown past any render window", () => {
    const s = assembleBank(NOW, moneyWith({ amount: 300_000_000, profit: 9_000_000, duration: 30, interest_rate: 41.24, until: NOW + 12 * DAY, invested_at: NOW - 18 * DAY }));
    expect(s.state).toBe("active");
    expect(s.maturesAt).toBe(NOW + 12 * DAY);
    expect(s.remainingSeconds).toBe(12 * DAY);
  });

  it("ACTIVE <7d: still counting down", () => {
    const s = assembleBank(NOW, moneyWith({ amount: 300_000_000, profit: 9_000_000, duration: 14, interest_rate: 41.24, until: NOW + 3 * DAY, invested_at: NOW - 11 * DAY }));
    expect(s.state).toBe("active");
    expect(s.remainingSeconds).toBe(3 * DAY);
  });

  it("EXACTLY at maturity (until === now): mature, zero remaining — never a countdown", () => {
    const s = assembleBank(NOW, moneyWith({ amount: 300_000_000, profit: 9_000_000, duration: 14, interest_rate: 41.24, until: NOW, invested_at: NOW - 14 * DAY }));
    expect(s.state).toBe("mature");
    expect(s.remainingSeconds).toBe(0);
    expect(s.amount).toBe(300_000_000);
  });

  it("MATURE, NOT COLLECTED (the real payload): state mature, payout amount intact, no timer invented", () => {
    const parsed = UserMoneySchema.parse(REAL_MATURE_UNCOLLECTED);
    const s = assembleBank(NOW, parsed);
    expect(s.state).toBe("mature");
    expect(s.amount).toBe(352_152_800); // the money is still in the bank
    expect(s.maturesAt).toBeNull(); // Torn cleared the timer — do not fabricate one
    expect(s.remainingSeconds).toBe(0);
    expect(s.principal).toBe(344_000_000); // amount - profit (exact)
  });

  it("amount 0 → NONE (nothing invested)", () => {
    const s = assembleBank(NOW, moneyWith({ amount: 0, profit: 0, duration: 7, interest_rate: 41.24, until: null, invested_at: null }));
    expect(s.state).toBe("none");
    expect(s.amount).toBeNull();
  });

  it("COLLECTED (city_bank null) → NONE: only then does the card disappear", () => {
    const s = assembleBank(NOW, moneyWith(null));
    expect(s.state).toBe("none");
  });
});

describe("normalizeTornTimestamp edge (pre-existing helper, documented)", () => {
  it("unix seconds pass through; the null case never reaches it anymore", () => {
    expect(normalizeTornTimestamp(NOW + DAY, NOW)).toBe(NOW + DAY);
    expect(normalizeTornTimestamp((NOW + DAY) * 1000, NOW)).toBe(NOW + DAY);
  });
});
