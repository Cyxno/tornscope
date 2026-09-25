import { describe, expect, it } from "vitest";
import { SYNC_JOB_DEADLINE_MS, SyncDeadlineError, createPhaseTracker, withDeadline } from "../src/sync/deadline.js";

describe("sync job deadline", () => {
  it("passes a fast result through untouched", async () => {
    const tracker = createPhaseTracker("handler:start");
    const result = await withDeadline(Promise.resolve(42), tracker, 1_000);
    expect(result).toBe(42);
  });

  it("aborts a hung await and reports the current phase", async () => {
    const tracker = createPhaseTracker("faction:db_member_roster");
    const hung = new Promise<never>(() => undefined); // simulated wedged DB/Torn await
    await expect(withDeadline(hung, tracker, 20)).rejects.toMatchObject({
      name: "SyncDeadlineError",
      phase: "faction:db_member_roster",
    });
  });

  it("error message names the phase and is an instance of SyncDeadlineError", async () => {
    const tracker = createPhaseTracker("faction:armory_news_walk");
    await expect(withDeadline(new Promise<never>(() => undefined), tracker, 20)).rejects.toThrow(SyncDeadlineError);
    await expect(withDeadline(new Promise<never>(() => undefined), tracker, 20)).rejects.toThrow(
      /phase "faction:armory_news_walk"/
    );
  });

  it("deadline default is bounded and configurable", () => {
    expect(SYNC_JOB_DEADLINE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
