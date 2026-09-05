import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";
import { TornApiClient, splitLink, sanitizePath } from "../src/client.js";
import { TornApiError, tornKindForCode } from "../src/errors.js";
import { z } from "zod";

/**
 * Tests use a mocked fetch: no real Torn API calls are made and no real
 * responses are fabricated as fixtures - only minimal synthetic envelopes
 * matching the documented response shape.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RateLimiter", () => {
  it("serializes concurrent runs", async () => {
    const limiter = new RateLimiter(0);
    let concurrent = 0;
    let maxConcurrent = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.run(async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent -= 1;
        })
      )
    );
    expect(maxConcurrent).toBe(1);
  });
});

describe("tornKindForCode", () => {
  it("classifies documented Torn error codes", () => {
    expect(tornKindForCode(2).kind).toBe("key_invalid");
    expect(tornKindForCode(5).kind).toBe("rate_limited");
    expect(tornKindForCode(8).kind).toBe("transient");
    expect(tornKindForCode(16).kind).toBe("access_denied");
    expect(tornKindForCode(17).kind).toBe("transient");
    expect(tornKindForCode(18).kind).toBe("key_paused");
  });
});

describe("TornApiClient", () => {
  function clientWith(fetchImpl: ReturnType<typeof vi.fn>): TornApiClient {
    return new TornApiClient("TESTKEY123", {
      baseUrl: "https://api.torn.com/v2",
      minRequestIntervalMs: 0,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      logger: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  }

  it("returns validated data and hides the key from URLs", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).not.toContain("TESTKEY123");
      return jsonResponse({ profile: { id: 1, name: "Test", level: 10 } });
    });
    const client = clientWith(fetchImpl);
    const schema = z.object({ profile: z.object({ id: z.number(), name: z.string(), level: z.number() }) });
    const result = await client.get("/user/basic", { from: 123 }, schema);
    expect(result.profile.name).toBe("Test");
    const calledUrl = String(fetchImpl.mock.calls[0]![0]);
    expect(calledUrl).toContain("/user/basic");
    const headers = (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("ApiKey TESTKEY123");
  });

  it("maps Torn error payloads to classified TornApiError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 2, error: "Incorrect Key" } }));
    const client = clientWith(fetchImpl);
    await expect(client.get("/user/basic")).rejects.toMatchObject({ kind: "key_invalid", tornCode: 2 });
  });

  it("retries transient errors then succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse({ error: { code: 17, error: "backend error occurred, try again" } });
      return jsonResponse({ profile: { id: 1 } });
    });
    const client = clientWith(fetchImpl);
    const result = await client.get("/user/profile");
    expect((result as { profile: { id: number } }).profile.id).toBe(1);
    expect(calls).toBe(3);
  });

  it("does not retry permanent errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { code: 2, error: "Incorrect Key" } }));
    const client = clientWith(fetchImpl);
    await expect(client.get("/user/basic")).rejects.toBeInstanceOf(TornApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows _metadata.links.next pagination", async () => {
    const pages = [
      { log: [{ id: 1 }], _metadata: { links: { next: "https://api.torn.com/v2/user/log?offset=2&key=TESTKEY123" } } },
      { log: [{ id: 2 }], _metadata: { links: { next: null } } },
    ];
    let call = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      expect(u).not.toContain("key=TESTKEY123"); // key stripped from links
      return jsonResponse(pages[call++]!);
    });
    const client = clientWith(fetchImpl);
    const seen: number[] = [];
    await client.paginate("/user/log", { limit: 1 }, ({ data }) => {
      const arr = (data as { log: Array<{ id: number }> }).log;
      seen.push(...arr.map((l) => l.id));
    });
    expect(seen).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops paginating when onPage returns false", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return jsonResponse({ log: [{ id: 1 }], _metadata: { links: { next: "https://api.torn.com/v2/user/log?offset=2" } } });
    });
    const client = clientWith(fetchImpl);
    await client.paginate("/user/log", {}, () => false);
    expect(calls).toBe(1);
  });
});

describe("link helpers", () => {
  it("splitLink strips the key param", () => {
    const parsed = splitLink("https://api.torn.com/v2/user/log?offset=5&key=SECRET");
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual({ offset: "5" });
    expect(parsed!.path).toBe("/v2/user/log");
  });

  it("sanitizePath removes query strings", () => {
    expect(sanitizePath("/user/log?cat=7&key=SECRET")).toBe("/user/log");
  });
});

describe("fetch default", () => {
  it("falls back to global fetch when no fetchImpl is injected (production path)", async () => {
    const stub = vi.fn(async () => jsonResponse({ info: { access: { level: 4 } } }));
    const original = globalThis.fetch;
    globalThis.fetch = stub as typeof fetch;
    try {
      // No options at all — exactly how apps/api constructs the client.
      const client = new TornApiClient("testkey");
      await client.get("/key/info");
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = original;
    }
  });
});
