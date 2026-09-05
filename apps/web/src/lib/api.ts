import type {
  ApiKeyStatusResponse,
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
    readonly status: number
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiClientError(err?.code ?? "unknown_error", err?.message ?? `Request failed (${response.status})`, response.status);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
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
  syncRetryFailed: () => api.post<{ queued: string[] }>("/sync/retry-failed"),
  syncBackfill: () => api.post<{ queued: number }>("/sync/backfill"),
  setDemoView: (enabled: boolean) => api.post<MeResponse>("/demo-view", { enabled }),
  apiKeyStatus: () => api.get<ApiKeyStatusResponse>("/settings/api-key"),
  saveApiKey: (key: string) => api.post<ApiKeyStatusResponse>("/settings/api-key", { key }),
  deleteApiKey: () => api.del<{ deleted: boolean }>("/settings/api-key"),
};
