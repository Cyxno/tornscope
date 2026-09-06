import { describe, expect, it } from "vitest";
import { buildWalletBridge, type WalletFlowRow } from "../src/money.js";

/**
 * Wallet-bridge regression tests: OC payouts credited to the FACTION MEMBER
 * BALANCE are not wallet cash. Observed live: the ledger counted an OC payout
 * as wallet inflow and the bridge reported a phantom unreconciled gap of
 * exactly that payout.
 */

const FLOWS: WalletFlowRow[] = [
  { amount: 1_701_498, direction: "income", category: "faction" }, // OC payout → balance
  { amount: 750_000, direction: "income", category: "salary" },
  { amount: 95_494, direction: "income", category: "crime" },
  { amount: -50_000, direction: "expense", category: "items" },
  { amount: -352_500, direction: "expense", category: "housing" },
  { amount: -784_000, direction: "expense", category: "plushie" },
];

describe("wallet cash bridge", () => {
  it("excludes faction-balance credits from wallet flows; the 1D live gap reconciles to zero", () => {
    const credits = 1_701_498;
    const walletFlows = FLOWS.filter((r) => !(r.category === "faction" && r.direction === "income" && r.amount === credits));
    const bridge = buildWalletBridge(walletFlows, 1_281_672, 940_666, credits);

    expect(bridge.walletInflow).toBe(845_494);
    expect(bridge.walletOutflow).toBe(1_186_500);
    expect(bridge.expectedEndingCash).toBe(940_666);
    expect(bridge.unreconciled).toBe(0);
    expect(bridge.factionBalanceCredits).toBe(credits);
    expect(bridge.coverage).toBe("full");
  });

  it("counts the phantom gap when the credit is NOT excluded (regression guard on the old behavior)", () => {
    const bridge = buildWalletBridge(FLOWS, 1_281_672, 940_666, 0);
    // Old behavior: unreconciled = exactly the miscredited payout.
    expect(bridge.walletInflow).toBe(2_546_992);
    expect(bridge.unreconciled).toBe(-1_701_498);
  });

  it("bank transfers are wallet outflows/inflows, never profit", () => {
    const bridge = buildWalletBridge(
      [
        { amount: -344_000_000, direction: "neutral", category: "city_bank" },
        { amount: 285_835_500, direction: "neutral", category: "cayman_bank" },
      ],
      1_000_000,
      942_835_500 - 344_000_000,
      0
    );
    expect(bridge.bankDeposits).toBe(344_000_000);
    expect(bridge.bankWithdrawals).toBe(285_835_500);
  });

  it("coverage is partial when the starting snapshot is missing and null arithmetic is avoided", () => {
    const bridge = buildWalletBridge(FLOWS, null, 940_666, 1_701_498);
    expect(bridge.coverage).toBe("partial");
    expect(bridge.expectedEndingCash).toBeNull();
    expect(bridge.unreconciled).toBeNull();
  });
});
