import { z } from "zod";
import type { TornApiClient, TornMetadata, TornRequestParams } from "./client.js";

/**
 * Light runtime validation for the Torn API v2 responses we consume.
 * Schemas mirror the official OpenAPI spec (torn.com/swagger/openapi.json,
 * spec version 6.13.1) but use loose objects: unknown fields pass through so
 * raw payloads can be archived in JSONB without data loss.
 *
 * NOTE ON LOG PAYLOADS: Torn documents log `data` as dynamic key-value pairs
 * ("Dynamic key-value pairs related to the log"). Field names inside `data`
 * are NOT part of the OpenAPI contract, so we never parse them speculatively
 * here - they are carried as opaque records and interpreted defensively by
 * the normalization layer, with the raw payload always retained.
 */

const loose = z.looseObject;

export const KeyInfoSchema = loose({
  info: loose({
    selections: loose({}).optional(),
    user: loose({
      id: z.number(),
      faction_id: z.number().nullable().optional(),
      company_id: z.number().nullable().optional(),
    }),
    access: loose({
      level: z.number(),
      type: z.string(),
      log: loose({
        custom_permissions: z.boolean().optional(),
        available: z.array(loose({ category: z.number().optional(), title: z.string().optional() })).optional(),
      }).optional(),
    }),
  }),
});
export type TornKeyInfo = z.infer<typeof KeyInfoSchema>;

export const UserBasicSchema = loose({
  profile: loose({
    id: z.number(),
    name: z.string(),
    level: z.number(),
    gender: z.string().optional(),
    status: loose({}).optional(),
  }),
});
export type TornUserBasic = z.infer<typeof UserBasicSchema>;

export const UserProfileSchema = loose({
  profile: loose({
    id: z.number(),
    name: z.string(),
    level: z.number(),
    rank: z.string().optional(),
    title: z.string().optional(),
    age: z.number().optional(),
    signed_up: z.number().optional(),
    faction_id: z.number().nullable().optional(),
    property: loose({ id: z.number(), name: z.string() }).optional(),
    gender: z.string().nullable().optional(),
    status: loose({}).optional(),
    last_action: loose({}).optional(),
    donator_status: z.number().nullable().optional(),
    life: loose({ current: z.number(), maximum: z.number() }).optional(),
  }),
});
export type TornUserProfile = z.infer<typeof UserProfileSchema>;

export const UserNetworthSchema = loose({
  networth: loose({
    money: loose({
      pending: z.number(),
      wallet: z.number(),
      vault: z.number(),
      bookie: z.number(),
      city_bank: z.number(),
      cayman_bank: z.number(),
      piggy_bank: z.number(),
      loans: z.number(),
      unpaid_fees: z.number(),
    }),
    items: loose({
      inventory: z.number(),
      display_case: z.number(),
      bazaar: z.number(),
      trades: z.number(),
      item_market: z.number(),
      auction_house: z.number(),
      enlisted_cars: z.number(),
    }),
    assets: loose({
      property: z.number(),
      stock_market: z.number(),
      company: z.number(),
    }),
    points: z.number(),
    total: z.number(),
    timestamp: z.number(),
  }),
});
export type TornUserNetworth = z.infer<typeof UserNetworthSchema>;

export const UserMoneySchema = loose({
  money: loose({
    points: z.number(),
    wallet: z.number(),
    company: z.number(),
    vault: z.number(),
    cayman_bank: z.number(),
    city_bank: loose({ amount: z.number(), profit: z.number(), duration: z.number(), interest_rate: z.number(), until: z.number(), invested_at: z.number() }).nullable(),
    faction: loose({ money: z.number(), points: z.number() }).nullable(),
    daily_networth: z.number(),
  }),
});
export type TornUserMoney = z.infer<typeof UserMoneySchema>;

export const UserTravelSchema = loose({
  travel: loose({
    destination: z.string(),
    method: z.string().nullable(),
    departed_at: z.number().nullable(),
    arrival_at: z.number().nullable(),
    time_left: z.number(),
  }),
});
export type TornUserTravel = z.infer<typeof UserTravelSchema>;

/** Torn personalstats: flat map of stat name -> number. */
export const UserPersonalStatsSchema = loose({
  personalstats: z.record(z.string(), z.number()),
});
export type TornUserPersonalStats = z.infer<typeof UserPersonalStatsSchema>;

/** One Torn log entry. `data`/`params` are opaque by API contract. */
export const UserLogSchema = loose({
  id: z.number(),
  timestamp: z.number(),
  details: loose({
    id: z.number(),
    title: z.string(),
    category: z.string(),
  }),
  data: z.record(z.string(), z.unknown()),
  params: z.record(z.string(), z.unknown()),
});
export type TornUserLog = z.infer<typeof UserLogSchema>;

export const UserEventSchema = loose({
  id: z.number(),
  timestamp: z.number(),
  event: z.string(),
});
export type TornUserEvent = z.infer<typeof UserEventSchema>;

export const FactionBasicSchema = loose({
  basic: loose({
    id: z.number(),
    name: z.string(),
    tag: z.string().optional(),
    respect: z.number().optional(),
    days_old: z.number().optional(),
    capacity: z.number().optional(),
    members: z.number().optional(),
    leader_id: z.number().optional(),
    co_leader_id: z.number().nullable().optional(),
    best_chain: z.number().optional(),
  }),
});
export type TornFactionBasic = z.infer<typeof FactionBasicSchema>;

export const TornItemSchema = loose({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  is_tradable: z.boolean().optional(),
  value: loose({ market_price: z.number() }).optional(),
});
export type TornItem = z.infer<typeof TornItemSchema>;

export const TornLogCategorySchema = loose({
  id: z.number(),
  title: z.string(),
});
export type TornLogCategory = z.infer<typeof TornLogCategorySchema>;

export const TornLogTypeSchema = loose({
  id: z.number(),
  title: z.string(),
  category: z.number().optional(),
});
export type TornLogType = z.infer<typeof TornLogTypeSchema>;

/* -------------------------------------------------------------------------- */
/* Endpoint facade                                                            */
/* -------------------------------------------------------------------------- */

export interface LogQuery {
  category?: number;
  from?: number;
  to?: number;
  limit?: number;
}

export class TornEndpoints {
  constructor(private readonly client: TornApiClient) {}

  /** Key metadata: owner, access level, available log categories. */
  keyInfo(): Promise<TornKeyInfo> {
    return this.client.get("/key/info", {}, KeyInfoSchema);
  }

  userBasic(): Promise<TornUserBasic> {
    return this.client.get("/user/basic", {}, UserBasicSchema);
  }

  userProfile(): Promise<TornUserProfile> {
    return this.client.get("/user/profile", {}, UserProfileSchema);
  }

  userNetworth(): Promise<TornUserNetworth> {
    return this.client.get("/user/networth", {}, UserNetworthSchema);
  }

  /** Exact current cash positions per source (wallet, vault, banks...). */
  userMoney(): Promise<TornUserMoney> {
    return this.client.get("/user/money", {}, UserMoneySchema);
  }

  /** Current travel state (abroad / flying / home). */
  userTravel(): Promise<TornUserTravel> {
    return this.client.get("/user/travel", {}, UserTravelSchema);
  }

  userPersonalStats(cat: string = "all"): Promise<TornUserPersonalStats> {
    return this.client.get("/user/personalstats", { cat }, UserPersonalStatsSchema);
  }

  /** Single page of user logs. */
  userLogsPage(query: LogQuery = {}): Promise<{ log: TornUserLog[]; metadata: TornMetadata | undefined }> {
    const params: TornRequestParams = {
      cat: query.category,
      from: query.from,
      to: query.to,
      limit: query.limit ?? 100,
    };
    return this.client.getRaw("/user/log", params).then((page) => {
      const data = page.data as { log?: unknown };
      const log = z.array(UserLogSchema).parse(Array.isArray(data.log) ? data.log : []);
      return { log, metadata: page.metadata };
    });
  }

  /** Iterate all log pages matching the query via Torn pagination links. */
  async iterateUserLogs(
    query: LogQuery,
    onPage: (logs: TornUserLog[], metadata: TornMetadata | undefined) => boolean | void | Promise<boolean | void>,
    opts: { maxPages?: number } = {}
  ): Promise<void> {
    const params: TornRequestParams = {
      cat: query.category,
      from: query.from,
      to: query.to,
      limit: query.limit ?? 100,
    };
    await this.client.paginate(
      "/user/log",
      params,
      ({ data, metadata }) => {
        const parsed = z.array(UserLogSchema).parse(Array.isArray(data.log) ? data.log : []);
        return onPage(parsed, metadata);
      },
      opts
    );
  }

  /** Single page of user events. */
  userEventsPage(query: { from?: number; to?: number; limit?: number } = {}): Promise<{ events: TornUserEvent[]; metadata: TornMetadata | undefined }> {
    const params: TornRequestParams = {
      from: query.from,
      to: query.to,
      limit: query.limit ?? 100,
    };
    return this.client.getRaw("/user/events", params).then((page) => {
      const data = page.data as { events?: unknown };
      const events = z.array(UserEventSchema).parse(Array.isArray(data.events) ? data.events : []);
      return { events, metadata: page.metadata };
    });
  }

  /** Iterate all event pages via Torn pagination links. */
  async iterateUserEvents(
    query: { from?: number; to?: number; limit?: number },
    onPage: (events: TornUserEvent[], metadata: TornMetadata | undefined) => boolean | void | Promise<boolean | void>,
    opts: { maxPages?: number } = {}
  ): Promise<void> {
    const params: TornRequestParams = {
      from: query.from,
      to: query.to,
      limit: query.limit ?? 100,
    };
    await this.client.paginate(
      "/user/events",
      params,
      ({ data, metadata }) => {
        const parsed = z.array(UserEventSchema).parse(Array.isArray(data.events) ? data.events : []);
        return onPage(parsed, metadata);
      },
      opts
    );
  }

  factionBasic(): Promise<TornFactionBasic> {
    return this.client.get("/faction/basic", {}, FactionBasicSchema);
  }

  /** Public item catalog including market prices (used for resale estimates). */
  tornItems(cat: string = "All"): Promise<TornItem[]> {
    return this.client.get("/torn/items", { cat }, z.object({ items: z.array(TornItemSchema) }).transform((r) => r.items));
  }

  tornLogCategories(): Promise<TornLogCategory[]> {
    return this.client.get(
      "/torn/logcategories",
      {},
      z.object({ logcategories: z.array(TornLogCategorySchema) }).transform((r) => r.logcategories)
    );
  }

  tornLogTypes(category?: number): Promise<TornLogType[]> {
    const path = category === undefined ? "/torn/logtypes" : `/torn/${category}/logtypes`;
    return this.client.get(
      path,
      {},
      z.object({ logTypes: z.array(TornLogTypeSchema) }).transform((r) => r.logTypes)
    );
  }
}
