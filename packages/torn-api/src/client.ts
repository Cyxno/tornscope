import type { ZodType } from "zod";
import { RateLimiter, sleep } from "./rate-limiter.js";
import { TornApiError, TornNetworkError, tornKindForCode } from "./errors.js";

export interface TornClientLogger {
  debug?: (obj: object, msg?: string) => void;
  info?: (obj: object, msg?: string) => void;
  warn?: (obj: object, msg?: string) => void;
  error?: (obj: object, msg?: string) => void;
}

export interface TornApiClientOptions {
  baseUrl: string;
  minRequestIntervalMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  timeoutMs: number;
  logger: TornClientLogger;
  /** Shared limiter across client instances (one process = one limiter). */
  rateLimiter?: RateLimiter;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_TORN_CLIENT_OPTIONS: Omit<TornApiClientOptions, "logger" | "rateLimiter"> = {
  baseUrl: process.env.TORN_API_BASE_URL ?? "https://api.torn.com/v2",
  minRequestIntervalMs: Number(process.env.TORN_API_MIN_REQUEST_INTERVAL_MS ?? 700),
  maxRetries: 4,
  retryBaseDelayMs: 1500,
  timeoutMs: 20_000,
};

const SAFE_DEFAULT_LOGGER: TornClientLogger = {
  warn: (obj, msg) => console.warn("[torn-api]", msg ?? "", JSON.stringify(obj)),
  error: (obj, msg) => console.error("[torn-api]", msg ?? "", JSON.stringify(obj)),
};

/** Torn v2 pagination metadata. */
export interface TornMetadata {
  links?: { next?: string | null; prev?: string | null };
  nanostamp?: string;
}

/** Why a backward (historical) pagination walk stopped. */
export type BackwardStopReason =
  | "history_boundary_reached"
  | "source_exhausted"
  | "callback_stop"
  | "max_pages"
  | "cursor_stalled";

export interface BackwardPaginationResult {
  pages: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  stopReason: BackwardStopReason;
}

interface RawTornResponse {
  _metadata?: TornMetadata;
  error?: { code: number; error: string };
  [key: string]: unknown;
}

export interface TornRequestParams {
  [name: string]: string | number | boolean | undefined | null;
}

export interface TornPage<T> {
  data: T;
  metadata: TornMetadata | undefined;
}

/**
 * Process-local request accounting for one client instance. Used to measure
 * sync efficiency (denied/timeout/retry pressure) WITHOUT ever exposing the
 * key — counters only, no URLs, no params.
 */
export interface TornClientMetrics {
  requests: number;
  /** Requests Torn answered with an access/permission error (kind=access_denied). */
  denied: number;
  /** Requests that aborted on the client timeout. */
  timeouts: number;
  /** Retry attempts after a retryable failure. */
  retries: number;
  /** Requests that ended in any error. */
  errors: number;
  totalDurationMs: number;
}

function emptyMetrics(): TornClientMetrics {
  return { requests: 0, denied: 0, timeouts: 0, retries: 0, errors: 0, totalDurationMs: 0 };
}

export class TornApiClient {
  private readonly limiter: RateLimiter;
  private readonly opts: TornApiClientOptions;
  /** Cumulative counters since client construction (never reset). */
  readonly metrics: TornClientMetrics = emptyMetrics();

  /** Point-in-time copy of the counters (for per-run deltas). */
  metricsSnapshot(): TornClientMetrics {
    return { ...this.metrics };
  }

  constructor(
    /** API key is held privately and never logged. */
    private readonly apiKey: string,
    options: Partial<TornApiClientOptions> = {}
  ) {
    this.opts = {
      ...DEFAULT_TORN_CLIENT_OPTIONS,
      logger: SAFE_DEFAULT_LOGGER,
      // Default to the platform fetch unless a caller injects its own.
      fetchImpl: (...args) => globalThis.fetch(...args),
      ...options,
    } as TornApiClientOptions;
    this.limiter = options.rateLimiter ?? new RateLimiter(this.opts.minRequestIntervalMs);
  }

  /**
   * Perform a GET request, normalizing errors and retrying transient failures.
   * The API key is sent via the Authorization header so it never appears in
   * URLs, logs or pagination links.
   */
  async get<T>(path: string, params: TornRequestParams = {}, schema?: ZodType<T>): Promise<T> {
    const page = await this.getRaw(path, params);
    if (schema) return schema.parse(page.data);
    return page.data as T;
  }

  /**
   * GET that also returns pagination metadata (for callers that follow pages).
   */
  async getRaw(path: string, params: TornRequestParams = {}): Promise<TornPage<unknown>> {
    let attempt = 0;
    // Infinite loop protection: bounded retries with exponential backoff.
    for (;;) {
      attempt += 1;
      try {
        return await this.limiter.run(() => this.requestOnce(path, params));
      } catch (err) {
        this.metrics.errors += 1;
        if (err instanceof TornApiError && err.kind === "access_denied") this.metrics.denied += 1;
        const retryable = err instanceof TornApiError && err.retryable;
        if (!retryable || attempt > this.opts.maxRetries) throw err;
        this.metrics.retries += 1;
        const isRateLimit = err instanceof TornApiError && err.kind === "rate_limited";
        const delay = this.backoffDelay(attempt, isRateLimit);
        this.opts.logger.warn?.({ path: sanitizePath(path), attempt, delayMs: delay }, "retrying torn api request");
        await sleep(delay);
      }
    }
  }

  /**
   * Follow Torn's `_metadata.links.next` pagination. Fetches pages until the
   * last page or `onPage` returns false. Links are re-issued through the
   * authenticated client (any embedded key param is stripped before logging
   * or replaying).
   */
  async paginate(
    path: string,
    params: TornRequestParams,
    onPage: (page: { data: Record<string, unknown>; metadata: TornMetadata | undefined }) => boolean | void | Promise<boolean | void>,
    opts: { maxPages?: number } = {}
  ): Promise<void> {
    const maxPages = opts.maxPages ?? 500;
    let currentPath: string | null = path;
    let currentParams = params;

    for (let page = 0; page < maxPages; page++) {
      const result = await this.getRaw(currentPath, currentParams);
      const data = result.data as Record<string, unknown>;
      const again = await onPage({ data, metadata: result.metadata });
      if (again === false) return;

      const next = result.metadata?.links?.next ?? null;
      if (!next) return;
      const parsed = this.relativeLink(next);
      if (!parsed) return;
      currentPath = parsed.path;
      currentParams = parsed.params;
    }
  }

  /**
   * Walk Torn's history BACKWARD via `_metadata.links.prev`.
   *
   * Torn's v2 log/event endpoints return the NEWEST page first
   * (sort=desc, links.next = null) and expose OLDER pages only through
   * links.prev. Forward-only pagination therefore silently truncated every
   * historical backfill to its first page — this method is the correct way
   * to page from `now` (or `params.to`) down to the requested boundary.
   *
   * Stops are always explained so callers can persist WHY history stopped:
   * - history_boundary_reached: a page's oldest row is at/before the boundary
   * - source_exhausted: Torn returned no prev link (nothing older exists)
   * - callback_stop: the caller asked to stop
   * - max_pages: safety cap hit — history is INCOMPLETE
   * - cursor_stalled: prev kept returning the same window (defensive)
   */
  async paginateBackward(
    path: string,
    params: TornRequestParams,
    onPage: (page: { data: Record<string, unknown>; metadata: TornMetadata | undefined }) => boolean | void | Promise<boolean | void>,
    opts: { maxPages?: number; boundaryTs?: number; pageSize?: number; rowTimestamps?: (data: Record<string, unknown>) => number[] } = {}
  ): Promise<BackwardPaginationResult> {
    const maxPages = opts.maxPages ?? 500;
    const boundaryTs = opts.boundaryTs ?? null;
    const rowTimestamps = opts.rowTimestamps;
    const pageSize = opts.pageSize;
    let currentPath: string | null = path;
    let currentParams: TornRequestParams | null = params;
    let pages = 0;
    let oldestSeen: number | null = null;
    let newestSeen: number | null = null;
    let lastWindow: string | null = null;

    while (pages < maxPages) {
      if (!currentPath || !currentParams) return finish("source_exhausted");
      const result = await this.getRaw(currentPath, currentParams);
      const data = result.data as Record<string, unknown>;
      pages += 1;

      const timestamps = rowTimestamps ? rowTimestamps(data) : [];
      for (const ts of timestamps) {
        if (oldestSeen === null || ts < oldestSeen) oldestSeen = ts;
        if (newestSeen === null || ts > newestSeen) newestSeen = ts;
      }

      const again = await onPage({ data, metadata: result.metadata });
      if (again === false) return finish("callback_stop");

      // Boundary: the requested history start is covered by this page.
      if (boundaryTs !== null && timestamps.length > 0) {
        const pageOldest = Math.min(...timestamps);
        if (pageOldest <= boundaryTs) return finish("history_boundary_reached");
      }
      // Empty page: Torn clamps pages to the requested window, so an empty
      // page means no rows exist at/after the boundary. CRITICAL: Torn still
      // advertises a prev link here whose pages IGNORE from — following it
      // re-serves entire below-window history every cycle. Stop instead.
      if (timestamps.length === 0) {
        return finish(boundaryTs !== null ? "history_boundary_reached" : "source_exhausted");
      }
      // Short page: fewer rows than the page size also means this window
      // holds nothing further — the walk is complete.
      if (pageSize !== undefined && timestamps.length < pageSize) {
        return finish("history_boundary_reached");
      }

      const prev = result.metadata?.links?.prev ?? null;
      const parsedPrev = prev ? this.relativeLink(prev) : null;
      if (!prev || !parsedPrev) return finish("source_exhausted");

      // Torn quirk: at the true end of a category's history the advertised
      // prev link can repeat forever (pointing at a window that was already
      // served). Following it only re-serves the same rows, so a repeated
      // link means there are no older rows left — source exhausted.
      const windowKey = JSON.stringify({ p: parsedPrev.path, q: parsedPrev.params });
      if (lastWindow !== null && windowKey === lastWindow) return finish("source_exhausted");
      lastWindow = windowKey;

      currentPath = parsedPrev.path;
      currentParams = parsedPrev.params;
    }

    return finish("max_pages");

    function finish(reason: BackwardStopReason): BackwardPaginationResult {
      // If the walk already collected rows at/before the requested boundary,
      // the requested history IS fully covered — even when the safety cap
      // stopped the walk. Report the covered truth.
      if (reason === "max_pages" && boundaryTs !== null && oldestSeen !== null && oldestSeen <= boundaryTs) {
        return { pages, oldestTimestamp: oldestSeen, newestTimestamp: newestSeen, stopReason: "history_boundary_reached" };
      }
      return { pages, oldestTimestamp: oldestSeen, newestTimestamp: newestSeen, stopReason: reason };
    }
  }

  private backoffDelay(attempt: number, rateLimited: boolean): number {
    const exponential = this.opts.retryBaseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.3 * exponential;
    return Math.round(exponential + jitter + (rateLimited ? 2000 : 0));
  }

  private async requestOnce(path: string, params: TornRequestParams): Promise<TornPage<unknown>> {
    const url = this.buildUrl(path, params);
    const startedAt = Date.now();
    this.metrics.requests += 1;
    let response: Response;
    try {
      response = await this.opts.fetchImpl!(url, {
        method: "GET",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      this.metrics.totalDurationMs += Date.now() - startedAt;
      if ((err as { name?: string }).name === "TimeoutError" || (err as { cause?: { name?: string } }).cause?.name === "TimeoutError") {
        this.metrics.timeouts += 1;
      }
      throw new TornNetworkError(`torn api request failed: ${sanitizePath(path)}`, err);
    }

    const durationMs = Date.now() - startedAt;
    this.metrics.totalDurationMs += durationMs;
    this.opts.logger.debug?.({ path: sanitizePath(path), status: response.status, durationMs }, "torn api request");

    let body: RawTornResponse;
    try {
      body = (await response.json()) as RawTornResponse;
    } catch {
      if (!response.ok) {
        throw new TornApiError(`torn api returned http ${response.status}`, {
          kind: "transient",
          status: response.status,
          retryable: response.status >= 500,
        });
      }
      throw new TornApiError("torn api returned invalid json", { kind: "permanent", status: response.status });
    }

    if (body.error) {
      const { kind } = tornKindForCode(body.error.code);
      throw new TornApiError(`torn api error ${body.error.code}: ${body.error.error}`, {
        kind,
        tornCode: body.error.code,
        status: response.status,
      });
    }

    if (!response.ok) {
      throw new TornApiError(`torn api returned http ${response.status}`, {
        kind: response.status >= 500 ? "transient" : "permanent",
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    return { data: body, metadata: body._metadata };
  }

  private buildUrl(path: string, params: TornRequestParams): string {
    const base = this.opts.baseUrl.replace(/\/$/, "");
    const clean = path.startsWith("/") ? path : `/${path}`;
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      search.set(name, String(value));
    }
    const qs = search.toString();
    return `${base}${clean}${qs ? `?${qs}` : ""}`;
  }

  /**
   * Turn an absolute Torn pagination link into a path RELATIVE to the
   * configured base URL. Torn's links are absolute and INCLUDE the version
   * prefix (`https://api.torn.com/v2/user/log?...`); naively re-joining them
   * onto the base produced `…/v2/v2/user/log`, which Torn answers with a
   * misleading "access level" error. This keeps forward and backward
   * pagination working regardless of the configured base (also proxies).
   */
  private relativeLink(link: string): { path: string; params: TornRequestParams } | null {
    const parsed = splitLink(link);
    if (!parsed) return null;
    let base: URL;
    try {
      base = new URL(this.opts.baseUrl);
    } catch {
      return parsed;
    }
    const prefix = base.pathname.replace(/\/$/, "");
    if (prefix && parsed.path.startsWith(prefix)) {
      parsed.path = parsed.path.slice(prefix.length) || "/";
    }
    return parsed;
  }
}

/** Split an absolute Torn pagination link into path + params (key stripped). */
export function splitLink(link: string): { path: string; params: TornRequestParams } | null {
  try {
    const url = new URL(link);
    const params: TornRequestParams = {};
    for (const [name, value] of url.searchParams.entries()) {
      if (name === "key") continue; // never propagate or log keys
      params[name] = value;
    }
    return { path: url.pathname, params };
  } catch {
    return null;
  }
}

/** Strip query strings so request logging never sees URL params. */
export function sanitizePath(path: string): string {
  return path.split("?")[0] ?? path;
}
