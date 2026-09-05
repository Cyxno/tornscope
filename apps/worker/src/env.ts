import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    // Defense in depth: never log secrets even if they end up in an object.
    paths: ["apiKey", "api_key", "key", "*.apiKey", "*.api_key", "*.key", "authorization"],
    censor: "[REDACTED]",
  },
});

export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  tornBaseUrl: process.env.TORN_API_BASE_URL ?? "https://api.torn.com/v2",
  tornMinRequestIntervalMs: Number(process.env.TORN_API_MIN_REQUEST_INTERVAL_MS ?? 700),
  initialHistoryDays: Math.min(180, Number(process.env.TORN_SYNC_INITIAL_HISTORY_DAYS ?? 180)),
  encryptionKey: process.env.API_KEY_ENCRYPTION_KEY ?? "",
} as const;
