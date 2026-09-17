import { existsSync, readFileSync } from "node:fs";
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

/** Decoded byte length of a base64url/base64 VAPID value, or null when the
 *  string is not decodable. Lengths only — never the material itself. */
function vapidDecodedLength(value: string): number | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const bytes = Buffer.from(normalized, "base64");
  return bytes.length > 0 ? bytes.length : null;
}

/** Boot-time push configuration sanity: warn (never crash) when keys are
 *  present but not the P-256 shapes web-push expects, so a bad key is
 *  diagnosable from server logs instead of from user-facing errors. */
export function validateVapidConfig(): void {
  if (env.vapidPublicKey === "" && env.vapidPrivateKey === "") return;
  const publicBytes = vapidDecodedLength(env.vapidPublicKey);
  const privateBytes = vapidDecodedLength(env.vapidPrivateKey);
  if (publicBytes !== 65) {
    logger.warn({ publicBytes }, "VAPID_PUBLIC_KEY does not decode to a 65-byte P-256 public key — push subscriptions will fail");
  }
  if (privateBytes !== 32) {
    logger.warn({ privateBytes }, "VAPID_PRIVATE_KEY does not decode to a 32-byte scalar — push delivery will fail");
  }
  // 1.0.3 production finding: Apple's push service (web.push.apple.com)
  // answers 403 BadJwtToken for VAPID subjects that are mailto: URLs on
  // reserved TLDs (.local etc.) — every iOS/PWA delivery fails while
  // desktop providers accept the same JWT. Warn loudly on that shape.
  if (/^mailto:[^@]*@[^.]*\.(local|localhost|test|example|invalid)\b/i.test(env.vapidSubject)) {
    logger.warn(
      { subject: env.vapidSubject },
      "VAPID_SUBJECT is a mailto: address on a reserved TLD — Apple (iOS/PWA) rejects it with BadJwtToken. Use an https:// origin or a real-domain mailto:"
    );
  }
}

/** VAPID subject fallback: the site's https origin when known — Apple
 *  accepts https: and real-domain mailto: subjects, but NOT reserved-TLD
 *  mailto: (see validateVapidConfig). Dev setups without a public origin
 *  keep the inert mailto default (no Apple devices there). */
function vapidSubjectDefault(publicBaseUrl: string): string {
  return /^https:\/\/\S+$/i.test(publicBaseUrl) ? publicBaseUrl : "mailto:alerts@tornscope.local";
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
  /**
   * Trust X-Forwarded-* headers when the API sits behind the reverse proxy.
   * Parsed from TRUST_PROXY (see parseTrustProxy). Set TRUST_PROXY=false
   * only for direct unproxied exposure.
   */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /** Web Push VAPID keys. Private key NEVER leaves the server; the public
   *  key is served to browsers (required for push subscription). Values are
   *  trimmed: stray whitespace/CRLF from env-file parsing would otherwise
   *  break every client-side key decode and server-side VAPID signing.
   *  The subject defaults to the public https origin — see
   *  vapidSubjectDefault (Apple rejects reserved-TLD mailto: subjects). */
  vapidPublicKey: (process.env.VAPID_PUBLIC_KEY ?? "").trim(),
  vapidPrivateKey: (process.env.VAPID_PRIVATE_KEY ?? "").trim(),
  vapidSubject: (process.env.VAPID_SUBJECT ?? "").trim() || vapidSubjectDefault((process.env.PUBLIC_BASE_URL ?? "").trim()),
  /** Owner binding stays enabled until explicitly disabled post-migration. */
  /** Abandoned anonymous profiles older than this are cleaned up. */
  guestRetentionDays: Number(process.env.GUEST_PROFILE_RETENTION_DAYS ?? 60),
  /**
   * Build identity (roadmap #9): the root package.json is the CANONICAL
   * version source — resolved at boot by walking up from cwd (containers
   * ship the repo root). APP_VERSION overrides for exotic deployments;
   * ENV_LABEL names non-public deployments ("Development").
   */
  build: resolveBuildVersion(),
  /**
   * Hosted abuse limits (roadmap #8). Centralized, env-tunable so a
   * self-hoster can loosen them; defaults are deliberately conservative for
   * a public single-node deployment. Security BASICS (auth, CSRF, SSRF,
   * isolation) never depend on these.
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

/**
 * Normalized ALLOWED_ORIGINS (V1.0 hardening): full ORIGIN strings
 * (scheme + host + port), never bare hosts. Pure + exported so request
 * paths and tests re-parse cheaply:
 *   - `https://example.com`        → accepted as-is;
 *   - `https://example.com:443`    → normalized to `https://example.com`;
 *   - entries with a path/query or a non-http(s) scheme are rejected
 *     (an origin has no path — accepting one would silently never match).
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out = new Set<string>();
  for (const value of (raw ?? "").split(",")) {
    const entry = value.trim();
    if (!entry) continue;
    try {
      const url = new URL(entry);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
      if (url.pathname !== "/" || url.search || url.hash) throw new Error("path");
      out.add(url.origin);
    } catch {
      // Boot-time visibility: an operator typo must not silently shrink the
      // allowed set to "everything looks fine until a browser shows up".
      console.warn(`[env] ignoring malformed ALLOWED_ORIGINS entry: ${JSON.stringify(entry)}`);
    }
  }
  return [...out];
}

/** The deployment's configured extra origins, normalized once at boot. */
export const allowedOrigins: string[] = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

function resolveBuildVersion(): { version: string; environment: string } {
  const override = process.env.APP_VERSION?.trim();
  let version = override || "";
  if (!version) {
    try {
      // Walk up from cwd: the containers run at /app/apps/{api} with the
      // repo root (and its canonical package.json) at /app.
      let dir = process.cwd();
      for (let i = 0; i < 5; i++) {
        const candidate = `${dir}/package.json`;
        if (existsSync(candidate)) {
          version = JSON.parse(readFileSync(candidate, "utf8")).version ?? "";
          if (version) break;
        }
        dir = `${dir}/..`;
      }
    } catch {
      // fall through to the safe placeholder
    }
  }
  return { version: version || "0.0.0-dev", environment: process.env.ENV_LABEL?.trim() || "Public Testing" };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}
