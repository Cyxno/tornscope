import { describe, expect, it } from "vitest";
import { combatEventSemantics } from "../src/index.js";

/**
 * Combat feed semantics: the verb follows the USER's direction — outgoing is
 * "Attacked", incoming is "Defended" — and the outcome is derived from the
 * attacker-perspective result string. An incoming loss must never read as if
 * the user initiated and lost the fight.
 */
describe("combatEventSemantics", () => {
  it("outgoing win: verb Attacked, outcome won", () => {
    expect(combatEventSemantics("outgoing", "Attacked")).toEqual({ verb: "Attacked", outcome: "won", context: null });
    expect(combatEventSemantics("outgoing", "Mugged").outcome).toBe("won");
    expect(combatEventSemantics("outgoing", "Hospitalized").outcome).toBe("won");
    expect(combatEventSemantics("outgoing", "Arrested").outcome).toBe("won");
  });

  it("outgoing loss: verb Attacked, outcome lost", () => {
    const s = combatEventSemantics("outgoing", "Lost");
    expect(s.verb).toBe("Attacked");
    expect(s.outcome).toBe("lost");
    expect(s.context).toBe("Lost");
  });

  it("outgoing defended-against: my attack failed", () => {
    expect(combatEventSemantics("outgoing", "Defended").outcome).toBe("lost");
  });

  it("incoming successful defense: verb Defended, outcome won", () => {
    expect(combatEventSemantics("incoming", "Defended")).toEqual({ verb: "Defended", outcome: "won", context: null });
    expect(combatEventSemantics("incoming", "Lost").outcome).toBe("won");
  });

  it("incoming lost defense (mugged/hospitalized): verb Defended, outcome lost", () => {
    const mugged = combatEventSemantics("incoming", "Mugged");
    expect(mugged.verb).toBe("Defended");
    expect(mugged.outcome).toBe("lost");
    expect(mugged.context).toBe("Mugged");
    expect(combatEventSemantics("incoming", "Hospitalized").outcome).toBe("lost");
  });

  it("unknown/stalemate results are neutral with context kept", () => {
    for (const result of ["Stalemate", "Escape", "Timeout", "Assist"]) {
      const s = combatEventSemantics("outgoing", result);
      expect(s.outcome).toBe("neutral");
      expect(s.verb).toBe("Attacked");
      expect(s.context).toBe(result);
    }
  });
});
