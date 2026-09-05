import { afterEach, describe, expect, it, vi } from "vitest";
import { TornApiClient } from "../src/client.js";

/**
 * Backward (historical) pagination tests.
 *
 * Torn's v2 /user/log and /user/events return the NEWEST page first with
 * links.next = null and expose older pages ONLY through links.prev. These
 * tests simulate that real behavior with synthetic envelopes (no real API
 * calls) and verify the walk stops for the right, reportable reason.
 */

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

interface PageSpec {
  /** Row timestamps on this page (newest-first as Torn sends them). */
  timestamps: number[];
  /** prev link the API advertises (null = source exhausted). */
  prev: string | null;
}

function clientWithPages(pages: PageSpec[]) {
  const fetchImpl = vi.fn();
  for (const page of pages) {
    fetchImpl.mockImplementationOnce(async () =>
      jsonResponse({
        log: page.timestamps.map((t, i) => ({
          id: String(t * 1000 + i),
          timestamp: t,
          details: { id: 6000, title: "Travel depart", category: "Travel" },
          data: {},
          params: {},
        })),
        _metadata: { links: { next: null, prev: page.prev } },
      })
    );
  }
  const client = new TornApiClient("TESTKEY123", {
    baseUrl: "https://api.torn.com/v2",
    minRequestIntervalMs: 0,
    maxRetries: 0,
    timeoutMs: 1000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    logger: {},
  });
  return { client, fetchImpl };
}

const DAY = 86_400;
const NOW = 1_800_000_000;

describe("paginateBackward", () => {
  it("walks multiple pages backward through links.prev", async () => {
    const { client, fetchImpl } = clientWithPages([
      { timestamps: [NOW, NOW - 100], prev: "https://api.torn.com/v2/user/log?cat=61&from=1&to=100" },
      { timestamps: [100, 50], prev: null },
    ]);
    const pagesSeen: number[] = [];
    const result = await client.paginateBackward(
      "/user/log",
      { cat: 61, limit: 100 },
      ({ data }) => {
        const logs = (data as { log: Array<{ timestamp: number }> }).log;
        pagesSeen.push(logs.length);
      },
      { rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp) }
    );
    expect(pagesSeen).toEqual([2, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.pages).toBe(2);
    expect(result.stopReason).toBe("source_exhausted");
    expect(result.oldestTimestamp).toBe(50);
    expect(result.newestTimestamp).toBe(NOW);
    // The second request must follow the prev link (older window).
    const secondUrl = fetchImpl.mock.calls[1]![0] as string;
    expect(secondUrl).toContain("to=100");
  });

  it("stops with history_boundary_reached when a page reaches the requested boundary", async () => {
    const boundary = NOW - 10 * DAY;
    const { client, fetchImpl } = clientWithPages([
      { timestamps: [NOW, boundary - 3600], prev: "https://api.torn.com/v2/user/log?cat=61&from=1&to=1" },
    ]);
    const result = await client.paginateBackward(
      "/user/log",
      { cat: 61, limit: 100 },
      () => {},
      { boundaryTs: boundary, rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp) }
    );
    // The page already contains a row at/before the boundary: no second page.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("history_boundary_reached");
    expect(result.oldestTimestamp).toBe(boundary - 3600);
  });

  it("reports source_exhausted when Torn has no prev link", async () => {
    const { client } = clientWithPages([{ timestamps: [NOW, NOW - 50], prev: null }]);
    const result = await client.paginateBackward("/user/log", { cat: 61, limit: 100 }, () => {}, {
      boundaryTs: NOW - 30 * DAY,
      rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp),
    });
    expect(result.stopReason).toBe("source_exhausted");
  });

  it("detects a stalled cursor (identical prev window twice) and stops", async () => {
    const samePrev = "https://api.torn.com/v2/user/log?cat=61&from=1&to=1";
    const { client, fetchImpl } = clientWithPages([
      { timestamps: [NOW, NOW - 10], prev: samePrev },
      { timestamps: [NOW - 5, NOW - 6], prev: samePrev },
      { timestamps: [NOW - 7, NOW - 8], prev: samePrev },
    ]);
    const result = await client.paginateBackward("/user/log", { cat: 61, limit: 100 }, () => {}, {
      rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp),
    });
    expect(result.stopReason).toBe("cursor_stalled");
    // Initial page + 2 stalled confirmations, then stop before a 4th call.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("stops with max_pages (incomplete) when the safety cap is hit", async () => {
    // A real multi-page history: each page advertises an older window.
    const pages = Array.from({ length: 5 }, (_, i) => ({
      timestamps: [NOW - i * DAY],
      prev: `https://api.torn.com/v2/user/log?cat=61&to=${NOW - (i + 1) * DAY}`,
    }));
    const { client } = clientWithPages(pages);
    const result = await client.paginateBackward("/user/log", { cat: 61, limit: 100 }, () => {}, {
      maxPages: 3,
      rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp),
    });
    expect(result.stopReason).toBe("max_pages");
    expect(result.pages).toBe(3);
  });

  it("stops with callback_stop when the caller asks", async () => {
    const { client, fetchImpl } = clientWithPages([
      { timestamps: [NOW], prev: "https://api.torn.com/v2/user/log?cat=61&to=1" },
      { timestamps: [NOW - 10], prev: null },
    ]);
    const result = await client.paginateBackward("/user/log", { cat: 61, limit: 100 }, () => false, {
      rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp),
    });
    expect(result.stopReason).toBe("callback_stop");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports history_boundary_reached when a stall happens after covering the boundary", async () => {
    // Torn sometimes keeps returning the same prev window at the end of a
    // category's history. If rows at/before the requested boundary were
    // already collected, the requested history is covered — the result must
    // say so instead of reporting an endless stall.
    const boundary = NOW - 180 * DAY;
    const samePrev = "https://api.torn.com/v2/user/log?cat=61&from=1&to=1";
    const { client } = clientWithPages([
      { timestamps: [NOW, boundary - 3600], prev: samePrev },
      { timestamps: [boundary - 7200], prev: samePrev },
      { timestamps: [boundary - 7200], prev: samePrev },
    ]);
    const result = await client.paginateBackward("/user/log", { cat: 61, limit: 100 }, () => {}, {
      boundaryTs: boundary,
      rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp),
    });
    expect(result.stopReason).toBe("history_boundary_reached");
    expect(result.oldestTimestamp!).toBeLessThanOrEqual(boundary);
  });

  it("propagates the api key via header, never via URL", async () => {
    const { client, fetchImpl } = clientWithPages([{ timestamps: [NOW], prev: null }]);
    await client.paginateBackward("/user/log", { cat: 61, limit: 100 }, () => {});
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).not.toContain("TESTKEY123");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("ApiKey TESTKEY123");
  });

  it("rewrites absolute prev links relative to the base (no doubled /v2/v2)", async () => {
    // Torn's prev links are ABSOLUTE and include the version prefix. Re-joining
    // them onto the base produced /v2/v2/user/log, which Torn answers with a
    // misleading access_denied (code 16).
    const { client, fetchImpl } = clientWithPages([
      { timestamps: [NOW], prev: "https://api.torn.com/v2/user/log?&limit=100&cat=61&sort=desc&from=1773076314&to=1786075052" },
      { timestamps: [NOW - DAY], prev: null },
    ]);
    await client.paginateBackward("/user/log", { cat: 61, limit: 100 }, () => {}, {
      rowTimestamps: (data) => (data as { log: Array<{ timestamp: number }> }).log.map((l) => l.timestamp),
    });
    const secondUrl = fetchImpl.mock.calls[1]![0] as string;
    expect(secondUrl).toContain("https://api.torn.com/v2/user/log?");
    expect(secondUrl).not.toContain("/v2/v2/");
    const url = new URL(secondUrl);
    expect(url.pathname).toBe("/v2/user/log");
    expect(url.searchParams.get("to")).toBe("1786075052");
    expect(url.searchParams.get("from")).toBe("1773076314");
    expect(url.searchParams.has("key")).toBe(false);
  });
});
