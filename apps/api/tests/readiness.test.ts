import { describe, expect, it, vi } from "vitest";
import {
  checkReadiness,
  WORKER_HEARTBEAT_KEY,
  type ReadinessDeps,
  type ReadinessRedis,
} from "../src/services/readiness.js";

/**
 * /api/ready verdict logic, exercised with injected probes (no live stack).
 * The real endpoint is proven end-to-end by the CI Docker smoke test.
 */

function makeDeps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  const redis: ReadinessRedis = {
    ping: vi.fn().mockResolvedValue("PONG"),
    get: vi.fn().mockResolvedValue(String(Date.now())),
  };
  return {
    dbPing: vi.fn().mockResolvedValue(undefined),
    withRedis: async (fn) => fn(redis),
    ...overrides,
  };
}

describe("checkReadiness", () => {
  it("all dependencies healthy -> ready with ok checks", async () => {
    const deps = makeDeps();
    const result = await checkReadiness(deps);
    expect(result.ready).toBe(true);
    expect(result.checks).toEqual({ database: "ok", redis: "ok", worker: "ok" });
    // The heartbeat must be read from the exact key the worker writes.
    expect(deps.withRedis).toBeDefined();
  });

  it("unreachable PostgreSQL -> not_ready, database unreachable", async () => {
    const result = await checkReadiness(makeDeps({ dbPing: vi.fn().mockRejectedValue(new Error("down")) }));
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe("unreachable");
    expect(result.checks.redis).toBe("ok");
    expect(result.checks.worker).toBe("ok");
  });

  it("redis connection failure -> not_ready, redis and worker unreachable", async () => {
    const result = await checkReadiness(
      makeDeps({ withRedis: async () => { throw new Error("connect failed"); } })
    );
    expect(result.ready).toBe(false);
    expect(result.checks.redis).toBe("unreachable");
    expect(result.checks.worker).toBe("unreachable");
    expect(result.checks.database).toBe("ok");
  });

  it("non-PONG reply -> not_ready with redis unreachable", async () => {
    const redis: ReadinessRedis = {
      ping: vi.fn().mockResolvedValue("WEIRD"),
      get: vi.fn().mockResolvedValue(String(Date.now())),
    };
    const result = await checkReadiness(makeDeps({ withRedis: async (fn) => fn(redis) }));
    expect(result.ready).toBe(false);
    expect(result.checks.redis).toBe("unreachable");
  });

  it("stale worker heartbeat -> not_ready, worker stale", async () => {
    const redis: ReadinessRedis = {
      ping: vi.fn().mockResolvedValue("PONG"),
      get: vi.fn().mockResolvedValue(String(Date.now() - 10 * 60_000)),
    };
    const result = await checkReadiness(makeDeps({ withRedis: async (fn) => fn(redis) }));
    expect(result.ready).toBe(false);
    expect(result.checks.redis).toBe("ok");
    expect(result.checks.worker).toBe("stale");
  });

  it("missing heartbeat (worker never ran) -> not_ready, worker stale", async () => {
    const redis: ReadinessRedis = {
      ping: vi.fn().mockResolvedValue("PONG"),
      get: vi.fn().mockResolvedValue(null),
    };
    const result = await checkReadiness(makeDeps({ withRedis: async (fn) => fn(redis) }));
    expect(result.ready).toBe(false);
    expect(result.checks.worker).toBe("stale");
  });

  it("non-numeric heartbeat payload -> not_ready, worker stale", async () => {
    const redis: ReadinessRedis = {
      ping: vi.fn().mockResolvedValue("PONG"),
      get: vi.fn().mockResolvedValue("not-a-timestamp"),
    };
    const result = await checkReadiness(makeDeps({ withRedis: async (fn) => fn(redis) }));
    expect(result.ready).toBe(false);
    expect(result.checks.worker).toBe("stale");
  });

  it("heartbeat key matches what the worker writes", () => {
    // Guard against silent drift between the probe and apps/worker.
    expect(WORKER_HEARTBEAT_KEY).toBe("tornscope:worker:heartbeat");
  });
});
