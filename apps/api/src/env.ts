import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["apiKey", "api_key", "key", "*.apiKey", "*.api_key", "*.key", "authorization", "req.headers.authorization"],
    censor: "[REDACTED]",
  },
});

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  host: process.env.API_HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  tornBaseUrl: process.env.TORN_API_BASE_URL ?? "https://api.torn.com/v2",
  tornMinRequestIntervalMs: Number(process.env.TORN_API_MIN_REQUEST_INTERVAL_MS ?? 700),
  encryptionKey: process.env.API_KEY_ENCRYPTION_KEY ?? "",
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:5173",
} as const;
