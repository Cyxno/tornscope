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
  /** Public origin users browse (used only for documentation/headers). */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  /** Extra origins allowed for cookie-authenticated mutations (CSV). */
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? "",
  /**
   * Trust X-Forwarded-* headers when the API sits behind the reverse proxy.
   * Set TRUST_PROXY=false only for direct unproxied exposure.
   */
  trustProxy: process.env.TRUST_PROXY !== "false",
  /** Web Push VAPID keys. Private key NEVER leaves the server; the public
   *  key is served to browsers (required for push subscription). */
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:alerts@tornscope.local",
  /** Owner binding stays enabled until explicitly disabled post-migration. */
  /** Abandoned anonymous profiles older than this are cleaned up. */
  guestRetentionDays: Number(process.env.GUEST_PROFILE_RETENTION_DAYS ?? 60),
} as const;
