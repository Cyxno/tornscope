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
  /**
   * Requested initial history window in days (default 180). Configurable via
   * TORN_SYNC_INITIAL_HISTORY_DAYS — 30, 90, 180, 365 ... are all valid; the
   * value is not capped at 180, only clamped to a sane 1..3650 range.
   */
  initialHistoryDays: Math.max(1, Math.min(3650, Math.round(Number(process.env.TORN_SYNC_INITIAL_HISTORY_DAYS ?? 180)) || 180)),
  encryptionKey: process.env.API_KEY_ENCRYPTION_KEY ?? "",
  /**
   * Proactive Alerts engine (2.9.0). Disabling ALERTS_ENABLED stops new
   * evaluation AND dispatch; existing pending deliveries are retained, never
   * deleted. Numeric values are clamped to safe ranges — a stray value
   * degrades to the default instead of wedging the delivery loop.
   */
  alerts: {
    enabled: !/^(false|0|off|no)$/i.test((process.env.ALERTS_ENABLED ?? "").trim()),
    discordTimeoutMs: clampNumber(process.env.DISCORD_WEBHOOK_TIMEOUT_MS, 8000, 1000, 30_000),
    deliveryMaxRetries: clampNumber(process.env.ALERT_DELIVERY_MAX_RETRIES, 5, 0, 10),
  },
} as const;

function clampNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
