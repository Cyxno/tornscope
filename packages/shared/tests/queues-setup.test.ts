import { describe, expect, it } from "vitest";
import { buildSyncJobId, parseSyncJobId, SYNC_QUEUE, deriveSetupPhase } from "../src/index.js";

describe("queue ids", () => {
  it("builds job ids without ':' (BullMQ rejects colons in custom ids)", () => {
    const id = buildSyncJobId("cmto6576q0000p5019uqrbsko", "money_logs", 1788600513763);
    expect(id).not.toContain(":");
    expect(id).toMatch(/^sync\./);
  });

  it("round-trips through parseSyncJobId", () => {
    const id = buildSyncJobId("user1", "profile", "init123");
    expect(parseSyncJobId(id)).toEqual({ userId: "user1", resource: "profile", attempt: "init123" });
    expect(parseSyncJobId("scheduler-tick")).toBeNull();
  });

  it("keeps the shared queue name stable", () => {
    expect(SYNC_QUEUE).toBe("tornscope-sync");
  });
});

describe("deriveSetupPhase", () => {
  const res = (over: Partial<{ status: string; lastSuccessAt: number | null; lastAttemptAt: number | null }> = {}) => ({
    status: "idle",
    lastSuccessAt: null,
    lastAttemptAt: null,
    ...over,
  });

  it("no_key without a credential", () => {
    expect(deriveSetupPhase({ hasApiKey: false, resources: [] })).toBe("no_key");
    expect(deriveSetupPhase({ hasApiKey: false, resources: [res({ lastSuccessAt: 1 })] })).toBe("no_key");
  });

  it("queued before the first attempt", () => {
    expect(deriveSetupPhase({ hasApiKey: true, resources: [] })).toBe("queued");
    expect(deriveSetupPhase({ hasApiKey: true, resources: [res()] })).toBe("queued");
  });

  it("syncing while any resource is running", () => {
    expect(
      deriveSetupPhase({
        hasApiKey: true,
        resources: [res({ lastSuccessAt: 100 }), res({ status: "running", lastAttemptAt: 200 })],
      })
    ).toBe("syncing");
  });

  it("partial when some succeeded and others never ran", () => {
    expect(
      deriveSetupPhase({
        hasApiKey: true,
        resources: [res({ lastSuccessAt: 100 }), res()],
      })
    ).toBe("partial");
  });

  it("caught_up when everything succeeded", () => {
    expect(
      deriveSetupPhase({
        hasApiKey: true,
        resources: [res({ lastSuccessAt: 100 }), res({ lastSuccessAt: 200 })],
      })
    ).toBe("caught_up");
  });

  it("failed when only failures exist", () => {
    expect(deriveSetupPhase({ hasApiKey: true, resources: [res({ status: "failed", lastAttemptAt: 50 })] })).toBe("failed");
  });
});
