import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: ["apiKey", "api_key", "key", "*.apiKey", "*.api_key", "*.key", "authorization", "req.headers.authorization"],
    censor: "[REDACTED]",
  },
});

/**
 * TRUST_PROXY → Fastify `trustProxy`.
 *
 * The API's only legitimate peer is the web app's same-origin proxy; when
 * proxy trust is on, Fastify resolves req.ip and req.protocol from the
 * X-Forwarded-* chain that proxy forwards, so rate limits key on real
 * visitors instead of the proxy IP.
 *
 * Accepted values:
 * - unset / "true"  → trust the proxy hop (default deployment behind the
 *   web app's own proxy);
 * - "false"         → ignore X-Forwarded-* entirely (direct exposure);
 * - anything else   → a comma-separated proxy-addr subnet list or preset,
 *   e.g. "loopback" or "10.0.0.0/8,192.168.0.0/16" (must match the ACTUAL
 *   proxy chain — never guess it). Hop counts are NOT accepted: Fastify
 *   fails closed on numbers, so we refuse them at boot instead of silently
 *   weakening proxy trust.
 */
function parseTrustProxy(raw: string | undefined): boolean | string {
  const value = (raw ?? "true").trim();
  if (value === "" || /^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  if (/^\d+$/.test(value)) {
    throw new Error(
      "TRUST_PROXY does not accept hop counts (Fastify fails closed on numbers). " +
        "Use true, false, or a comma-separated subnet list matching the actual proxy chain, " +
        'e.g. TRUST_PROXY=10.0.0.0/8,192.168.0.0/16'
    );
  }
  return value;
}

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
   * Parsed from TRUST_PROXY (see parseTrustProxy). Set TRUST_PROXY=false
   * only for direct unproxied exposure.
   */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /** Web Push VAPID keys. Private key NEVER leaves the server; the public
   *  key is served to browsers (required for push subscription). */
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:alerts@tornscope.local",
  /** Owner binding stays enabled until explicitly disabled post-migration. */
  /** Abandoned anonymous profiles older than this are cleaned up. */
  guestRetentionDays: Number(process.env.GUEST_PROFILE_RETENTION_DAYS ?? 60),
  /**
   * Hosted abuse limits (roadmap #8). Centralized, env-tunable so a
   * self-hoster can loosen them; defaults suit a public beta. Security
   * BASICS (auth, CSRF, SSRF, isolation) never depend on these.
   */
  hosted: {
    /** Active sessions allowed per profile; oldest (by last-seen) are
     *  revoked beyond this when a new session is created. */
    maxSessionsPerProfile: clampInt(process.env.HOSTED_MAX_SESSIONS_PER_PROFILE, 10, 1, 50),
    /** Anonymous profile creations per IP per hour. */
    profileCreationsPerIpPerHour: clampInt(process.env.HOSTED_PROFILE_CREATIONS_PER_IP_PER_HOUR, 20, 1, 500),
    /** Active push devices per profile. */
    maxPushDevices: clampInt(process.env.HOSTED_MAX_PUSH_DEVICES, 10, 1, 25),
  },
} as const;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
