import type {
  ApiKeyStatusResponse,
  ApiKeyValidationResponse,
  DashboardResponse,
  DrugsSummaryResponse,
  CombatSummaryResponse,
  FactionOverviewResponse,
  FactionRankedWarsResponse,
  FactionMembersResponse,
  FactionChainsResponse,
  FactionOcsResponse,
  FactionLedgerResponse,
  CombatTimelineResponse,
  CrimesSummaryResponse,
  CrimesTimelineResponse,
  EconomySummaryResponse,
  MeResponse,
  MoneyEventDto,
  MoneySummaryResponse,
  NetworthResponse,
  Paginated,
  ProfileLinkResult,
  SyncHealthResponse,
  TimelineEventDto,
  TodayResponse,
  TravelSummaryResponse,
  TravelTripDto,
} from "@tornscope/shared";

/**
 * Typed browser API client. All calls go through the relative /api proxy.
 * Errors surface as ApiClientError with the backend's stable error code.
 */

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = null
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOnce<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: { accept: "application/json" },
      ...init,
    });
  } catch {
    throw new ApiClientError("network_error", "Could not reach the TornScope API. Is the backend running?", 0);
  }

  const body = (await response.json().catch(() => null)) as unknown;

  if (!response.ok) {
    const payload = body as { error?: { code?: string; message?: string; details?: unknown } } | null;
    const err = payload?.error;
    throw new ApiClientError(
      err?.code ?? "unknown_error",
      err?.message ?? `Request failed (${response.status})`,
      response.status,
      err?.details ?? null
    );
  }

  return body as T;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Cold-start bootstrap coalescing: the server answers parallel cookie-less
  // requests with a retryable 425 ("bootstrap_pending") while the ONE real
  // profile+session creation is in flight (plus a short grace window after
  // it). Retries carry the session cookie the winning response set, so all
  // requests resolve to the same profile. A 425 never reached route logic,
  // so retrying is safe for mutations too. The final retries deliberately
  // outlive the server's grace window: a DIFFERENT browser behind the same
  // address (no shared cookie) must be able to create its own profile there.
  const backoffMs = [250, 600, 1200, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce<T>(path, init);
    } catch (err) {
      const retryable = err instanceof ApiClientError && err.code === "bootstrap_pending" && attempt < backoffMs.length;
      if (!retryable) throw err;
      await sleep(backoffMs[attempt]!);
    }
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  /**
   * JSON POST. When `body` is omitted nothing is sent at all — no body and
   * no content-type — so payload-free endpoints stay valid HTTP instead of
   * tripping the backend's "Body cannot be empty when content-type is set"
   * JSON parser error. Pass `{}` explicitly when the endpoint contract
   * expects a (possibly empty) JSON object.
   */
  post: <T>(path: string, body?: unknown) =>
    request<T>(
      path,
      body === undefined
        ? { method: "POST" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    ),
  /** DELETE never carries a body or content-type. */
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

/* Typed helpers matching the shared contracts. */

export interface QueryRange {
  preset: string;
  from?: number;
  to?: number;
}

export function rangeQuery(range: QueryRange, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ preset: range.preset });
  if (range.from) params.set("from", String(range.from));
  if (range.to) params.set("to", String(range.to));
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return params.toString();
}

export const endpoints = {
  me: () => api.get<MeResponse>("/me"),
  today: () => api.get<TodayResponse>("/today"),
  dashboard: (range: QueryRange) => api.get<DashboardResponse>(`/dashboard?${rangeQuery(range)}`),
  networth: (range: QueryRange) => api.get<NetworthResponse>(`/networth?${rangeQuery(range)}`),
  economy: (range: QueryRange) => api.get<EconomySummaryResponse>(`/economy?${rangeQuery(range)}`),
  moneySummary: (range: QueryRange) => api.get<MoneySummaryResponse>(`/money/summary?${rangeQuery(range)}`),
  moneyEvents: (range: QueryRange, opts: { limit?: number; cursor?: string; category?: string; direction?: string; search?: string }): Promise<Paginated<MoneyEventDto>> => {
    const params = new URLSearchParams({ preset: range.preset, limit: String(opts.limit ?? 50) });
    if (range.from) params.set("from", String(range.from));
    if (range.to) params.set("to", String(range.to));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.category) params.set("category", opts.category);
    if (opts.direction) params.set("direction", opts.direction);
    if (opts.search) params.set("search", opts.search);
    return api.get(`/money/events?${params.toString()}`);
  },
  drugsSummary: (range: QueryRange, drugs: string[] | null): Promise<DrugsSummaryResponse> =>
    api.get(`/drugs/summary?${rangeQuery(range, drugs && drugs.length > 0 ? { drugs: drugs.join(",") } : {})}`),
  travelSummary: (range: QueryRange) => api.get<TravelSummaryResponse>(`/travel/summary?${rangeQuery(range)}`),
  factionOverview: (range: QueryRange) => api.get<FactionOverviewResponse>(`/faction/overview?${rangeQuery(range)}`),
  factionRankedWars: (range: QueryRange) => api.get<FactionRankedWarsResponse>(`/faction/ranked-wars?${rangeQuery(range)}`),
  factionMembers: (range: QueryRange) => api.get<FactionMembersResponse>(`/faction/members?${rangeQuery(range)}`),
  factionChains: (range: QueryRange) => api.get<FactionChainsResponse>(`/faction/chains?${rangeQuery(range)}`),
  factionOcs: (range: QueryRange) => api.get<FactionOcsResponse>(`/faction/organized-crimes?${rangeQuery(range)}`),
  factionLedger: (range: QueryRange) => api.get<FactionLedgerResponse>(`/faction/ledger?${rangeQuery(range)}`),
  crimesSummary: (range: QueryRange) => api.get<CrimesSummaryResponse>(`/crimes/summary?${rangeQuery(range)}`),
  crimesTimeline: (range: QueryRange, limit = 50, cursor?: string): Promise<CrimesTimelineResponse> => {
    const params = new URLSearchParams({ preset: range.preset, limit: String(limit) });
    if (range.from) params.set("from", String(range.from));
    if (range.to) params.set("to", String(range.to));
    if (cursor) params.set("cursor", cursor);
    return api.get(`/crimes/timeline?${params.toString()}`);
  },
  combatSummary: (range: QueryRange) => api.get<CombatSummaryResponse>(`/combat/summary?${rangeQuery(range)}`),
  combatTimeline: (range: QueryRange, limit = 50, cursor?: string): Promise<CombatTimelineResponse> => {
    const params = new URLSearchParams({ preset: range.preset, limit: String(limit) });
    if (range.from) params.set("from", String(range.from));
    if (range.to) params.set("to", String(range.to));
    if (cursor) params.set("cursor", cursor);
    return api.get(`/combat/timeline?${params.toString()}`);
  },
  travelHistory: (range: QueryRange, limit = 50): Promise<Paginated<TravelTripDto>> => api.get(`/travel/history?${rangeQuery(range)}&limit=${limit}`),
  timeline: (range: QueryRange, opts: { limit?: number; cursor?: string; type?: string } = {}): Promise<Paginated<TimelineEventDto>> => {
    const params = new URLSearchParams({ preset: range.preset, limit: String(opts.limit ?? 50) });
    if (range.from) params.set("from", String(range.from));
    if (range.to) params.set("to", String(range.to));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.type) params.set("type", opts.type);
    return api.get(`/timeline?${params.toString()}`);
  },
  syncStatus: () => api.get<{ running: boolean; resources: Array<{ resource: string; status: string; lastAttemptAt: number | null; lastSuccessAt: number | null; nextRunAt: number | null; recordsCollected: number; errorMessage: string | null }> }>("/sync/status"),
  syncHealth: () => api.get<SyncHealthResponse>("/sync/health"),
  syncRun: (resource: string, force = false) => api.post<{ queued: boolean }>("/sync/run", { resource, force }),
  syncRetryFailed: () => api.post<{ queued: string[] }>("/sync/retry-failed", {}),
  syncBackfill: () => api.post<{ queued: number }>("/sync/backfill", {}),
  setDemoView: (enabled: boolean) => api.post<MeResponse>("/demo-view", { enabled }),
  apiKeyStatus: () => api.get<ApiKeyStatusResponse>("/settings/api-key"),
  saveApiKey: (key: string, confirmNewProfile?: boolean) =>
    api.post<ApiKeyStatusResponse>("/settings/api-key", {
      key,
      ...(confirmNewProfile ? { confirmNewProfile: true } : {}),
    }),
  /** Validate a key WITHOUT storing it (replace-preview / access summary). */
  validateApiKey: (key: string) => api.post<ApiKeyValidationResponse>("/settings/api-key/validate", { key }),
  /** Link this browser to the existing profile of the key's Torn identity. */
  linkProfile: (key: string) => api.post<ProfileLinkResult>("/profile/link", { key }),
  signOutOtherSessions: () => api.post<{ revoked: number }>("/session/sign-out-others", {}),
  bindOwner: (token: string) => api.post<MeResponse>("/session/bind-owner", { token }),
  deleteProfile: () => api.post<{ deleted: boolean }>("/profile/delete", {}),
  deleteApiKey: () => api.del<{ deleted: boolean }>("/settings/api-key"),
};
