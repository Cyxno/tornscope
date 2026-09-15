import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getPrismaClient } from "@tornscope/database";
import { TtlMap } from "@tornscope/shared";
import { env, parseAllowedOrigins } from "./env.js";
import { AppError } from "./errors.js";

/**
 * Browser-bound anonymous identity.
 *
 * - The browser holds ONLY an opaque random token in an HttpOnly cookie.
 * - The server stores the token's SHA-256 hash in UserSession, pointing at
 *   the profile (User row) the browser is bound to.
 * - A browser without a valid session gets a fresh anonymous profile. To use
 *   an EXISTING profile from another browser, the player proves ownership of
 *   the profile's Torn identity with a valid API key (profile linking) —
 *   that is the only multi-device mechanism, and no legacy owner
 *   bind/recovery machinery exists anymore.
 * - The demo-view flag is per profile; it applies only when the profile has
 *   no active API credential.
 */

export const SESSION_COOKIE = "ts_session";
const SESSION_TTL_SECONDS = 365 * 24 * 3600;
const DEMO_VIEW_KEY = "demo_view";

export interface SessionUser {
  id: string;
  displayName: string;
  role: string;
  isDemo: boolean;
  timezone: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Whether the BROWSER-facing request is HTTPS — the session cookie's Secure
 * flag is derived from this. Fastify resolves req.protocol itself from the
 * X-Forwarded-Proto chain, honoring TRUST_PROXY: the header is only trusted
 * when the immediate peer passes the configured proxy trust (env.trustProxy),
 * otherwise the socket protocol is used. Keeping this on req.protocol (not a
 * hand-rolled header read) makes cookie security, rate-limit identities and
 * Fastify's own URL handling all follow the SAME proxy trust decision.
 */
export function requestIsSecure(req: FastifyRequest): boolean {
  return req.protocol === "https";
}

function serializeSessionCookie(token: string, secure: boolean, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Hash of the browser's current session token (null without a valid cookie). */
export function currentSessionTokenHash(req: FastifyRequest): string | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token ? hashToken(token) : null;
}

async function userForSession(
  db: ReturnType<typeof getPrismaClient>,
  token: string,
  req?: FastifyRequest
): Promise<SessionUser | null> {
  const session = await db.userSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt) return null;

  // Server-side session expiration: absolute (365d from creation) + idle
  // (90d since last activity). Expired sessions are revoked and rejected —
  // the browser transparently receives a fresh guest session when needed.
  {
    const now = Date.now();
    const ABSOLUTE_LIFETIME_MS = 365 * 86_400_000;
    const IDLE_LIFETIME_MS = 90 * 86_400_000;
    const created = session.createdAt.getTime();
    const lastSeen = session.lastSeenAt.getTime();
    if (now - created > ABSOLUTE_LIFETIME_MS || now - lastSeen > IDLE_LIFETIME_MS) {
      await db.userSession
        .update({ where: { id: session.id }, data: { revokedAt: new Date() } })
        .catch(() => undefined);
      return null;
    }
  }

  const user = session.user;
  if (!user) return null;

  // Per-profile demo view: applies only while the profile has NO ACTIVE API
  // credential (no credential, or a revoked one), so a connected key always
  // wins over the demo toggle.
  const [flag, credential] = await Promise.all([
    db.appSetting.findUnique({ where: { userId_key: { userId: user.id, key: DEMO_VIEW_KEY } } }),
    db.apiCredential.findUnique({ where: { userId: user.id }, select: { revokedAt: true } }),
  ]);
  const hasActiveCredential = credential !== null && credential.revokedAt === null;
  if (flag && !hasActiveCredential) {
    // Remember which REAL profile owns the session so leaving demo mode can
    // clear ITS flag (the resolved user is now the demo profile).
    if (req) (req as unknown as { sessionProfileId?: string }).sessionProfileId = user.id;
    const demo = await db.user.findUnique({ where: { email: "demo@tornscope.local" } });
    if (demo) return demo;
  }
  return user;
}

/** Max NEW anonymous profiles one IP may create per hour (session abuse
 *  guard). Env-tunable for self-hosters; defaults are deliberately
 *  conservative for a public single-node deployment. The map is TTL-bounded
 *  (TtlMap): an IP whose last hit is older than the window is fully dropped
 *  from retained state, so one-time visitor IPs cannot grow it forever. */
const PROFILE_CREATION_LIMIT = env.hosted.profileCreationsPerIpPerHour;
const PROFILE_CREATION_WINDOW_MS = 3600_000;
const profileCreationHits = new TtlMap<number[]>({
  ttlMs: PROFILE_CREATION_WINDOW_MS,
  maxEntries: 10_000,
  sweepEvery: 32,
});

/** Test hooks: retained-state size / deterministic reset + hit registration
 *  (so cleanup behavior is provable without creating real profiles). */
export function profileCreationHitsSizeForTests(): number {
  return profileCreationHits.size;
}
export function profileCreationHitsRetainedForTests(): number {
  return profileCreationHits.retainedSize;
}
export function sweepProfileCreationHitsForTests(): number {
  return profileCreationHits.sweep();
}
export function resetProfileCreationHitsForTests(): void {
  profileCreationHits.sweep(Number.POSITIVE_INFINITY);
}
export function recordProfileCreationHitForTests(ip: string): void {
  registerProfileCreationHit(ip, Date.now());
}

export class ProfileCreationRateLimited extends Error {
  readonly statusCode = 429;
  readonly code = "profile_rate_limited";
  constructor() {
    super("Too many new sessions from this address — try again later.");
  }
}

/**
 * Bootstrap coalescing: a browser's very first requests leave in parallel
 * before any session cookie exists, so every one of them looks anonymous.
 * Only ONE anonymous-profile creation per IP may be in flight; concurrent
 * cookie-less requests get a retryable 425 instead of silently creating
 * duplicate guest profiles. The browser retries with the session cookie the
 * winning response just set, so a cold page load yields exactly one session
 * and one profile. Non-browser clients (no cookie jar) retry manually.
 */
export class SessionBootstrapPending extends Error {
  readonly statusCode = 425;
  readonly code = "bootstrap_pending";
  constructor() {
    super("Identity setup in progress — retry with the session cookie.");
  }
}

interface BootstrapMarker {
  startedAt: number;
  completedAt?: number;
}
const inFlightBootstrap = new Map<string, BootstrapMarker>();
/** Fail-open ceiling: a crashed creation must never block new sessions. */
const BOOTSTRAP_STALE_MS = 5000;
/**
 * Post-creation grace: requests that arrive just after the winner finished
 * still carry no cookie (they left the browser before it existed). Keeping
 * the marker briefly directs them to retry with the fresh cookie instead of
 * creating their own profile.
 */
const BOOTSTRAP_GRACE_MS = 1500;
const bootstrapTimers = new Map<string, ReturnType<typeof setTimeout>>();

function bootstrapBlocked(ip: string, marker: BootstrapMarker | undefined): boolean {
  if (!marker) return false;
  const now = Date.now();
  if (marker.completedAt === undefined) return now - marker.startedAt < BOOTSTRAP_STALE_MS;
  return now - marker.completedAt < BOOTSTRAP_GRACE_MS;
}

/** Test hooks: pre-age an IP's in-flight marker / reset coalescing state. */
export function markStaleBootstrapForTests(ip: string): void {
  inFlightBootstrap.set(ip, { startedAt: Date.now() - BOOTSTRAP_STALE_MS - 1 });
}
export function clearBootstrapForTests(): void {
  for (const t of bootstrapTimers.values()) clearTimeout(t);
  bootstrapTimers.clear();
  inFlightBootstrap.clear();
}

/**
 * Record this attempt in the per-IP sliding window. Kept as its own step so
 * tests can prove retained-state cleanup (an IP whose hits are all expired
 * vanishes from the map) without creating real profiles.
 */
function registerProfileCreationHit(ip: string, now: number): void {
  const hits = (profileCreationHits.get(ip) ?? []).filter((t) => now - t < PROFILE_CREATION_WINDOW_MS);
  hits.push(now);
  profileCreationHits.set(ip, hits);
}

/** Create a fresh anonymous profile + session and set the cookie. */
async function createAnonymousSession(db: ReturnType<typeof getPrismaClient>, req: FastifyRequest, reply: FastifyReply): Promise<SessionUser> {
  // Session-abuse guard: bots hammering the API without cookies must not be
  // able to grow the users table unbounded. Existing valid sessions are
  // unaffected — this only gates NEW profile creation.
  // req.ip (never the raw X-Forwarded-For header): Fastify resolves the
  // trusted proxy chain when TRUST_PROXY is on, so a direct client cannot
  // mint a fresh spoofed IP per request.
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const hits = (profileCreationHits.get(ip) ?? []).filter((t) => now - t < PROFILE_CREATION_WINDOW_MS);
  if (hits.length >= PROFILE_CREATION_LIMIT) {
    throw new ProfileCreationRateLimited();
  }
  // Coalesce parallel cold bootstraps from the same address (see above).
  if (bootstrapBlocked(ip, inFlightBootstrap.get(ip))) {
    throw new SessionBootstrapPending();
  }
  const startedAt = now;
  inFlightBootstrap.set(ip, { startedAt });
  try {
    registerProfileCreationHit(ip, now);
    const suffix = randomBytes(3).toString("hex");
    const user = await db.user.create({ data: { displayName: `Guest ${suffix}`, role: "user" } });
    const token = newSessionToken();
    await enforceSessionCap(db, user.id);
    await db.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token) } });
    reply.header("Set-Cookie", serializeSessionCookie(token, requestIsSecure(req), SESSION_TTL_SECONDS));
    (req as unknown as { sessionProfileId?: string }).sessionProfileId = user.id;
    return user;
  } finally {
    // Enter the post-creation grace window, then drop the marker entirely.
    const mine = inFlightBootstrap.get(ip);
    if (mine && mine.startedAt === startedAt) {
      mine.completedAt = Date.now();
      const timer = setTimeout(() => {
        const current = inFlightBootstrap.get(ip);
        if (current && current.startedAt === startedAt) inFlightBootstrap.delete(ip);
        bootstrapTimers.delete(ip);
      }, BOOTSTRAP_GRACE_MS + 100);
      bootstrapTimers.set(ip, timer);
    }
  }
}

/**
 * Resolve (or lazily create) the browser-bound profile for this request.
 * Every personal route resolves ownership through this — a userId supplied
 * by the frontend is never trusted.
 */
export async function resolveSessionUser(req: FastifyRequest, reply: FastifyReply): Promise<SessionUser> {
  const db = getPrismaClient();
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const user = await userForSession(db, token, req);
    if (user) {
      // Touch at most once an hour to avoid a write per request.
      const now = Date.now();
      const session = await db.userSession.findUnique({ where: { tokenHash: hashToken(token) }, select: { lastSeenAt: true } });
      if (session && now - session.lastSeenAt.getTime() > 3600_000) {
        await db.userSession.update({ where: { tokenHash: hashToken(token) }, data: { lastSeenAt: new Date() } });
      }
      return user;
    }
  }
  return createAnonymousSession(db, req, reply);
}

/**
 * CSRF defense for cookie-authenticated mutations: browsers attach an Origin
 * header on cross-site requests, so a mismatched Origin is rejected.
 * SameSite=Lax is the first layer; this is the second.
 *
 * FULL-ORIGIN comparison (V1.0 hardening): a browser origin is
 * scheme + host + port, so the whole origin string is compared — not just
 * the host. An `http://` page on an otherwise-matching host is a DIFFERENT
 * origin and is rejected when the browser-facing scheme is https.
 *
 * The effective browser-facing origins are derived, in order:
 *   1. `req.protocol` + Host — Fastify resolves req.protocol honoring
 *      TRUST_PROXY, so this is the socket scheme unless a trusted proxy
 *      says otherwise (same decision as the session cookie's Secure flag);
 *   2. x-forwarded-proto + x-forwarded-host — ONLY when TRUST_PROXY is on
 *      (the same-origin proxy rewrites Host to the internal `api:3000` but
 *      forwards the browser's scheme/host; a direct client cannot spoof
 *      these past an untrusted hop);
 *   3. ALLOWED_ORIGINS — configured full origins, normalized once at boot.
 *
 * A cross-SITE attacker's page fails all three — its Origin is evil.com,
 * while the forwarded headers are set by our proxy, never by the attacker.
 * Requests WITHOUT an Origin header pass: non-browser clients (curl,
 * server-to-server) never send one, and browsers always do on cross-site
 * mutations — which is the threat this check exists for.
 */
export function assertSameOrigin(req: FastifyRequest): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.origin;
  if (!origin) return; // non-browser client (curl / server-to-server)
  let originValue = "";
  try {
    originValue = new URL(origin).origin;
  } catch {
    originValue = "";
  }
  if (!originValue || originValue === "null") {
    throw Object.assign(new Error("Cross-origin request rejected."), { statusCode: 403 });
  }

  // Re-parsed per mutation request (cheap; mutations only) so env changes in
  // tests and operators' per-process config always reflect current state.
  const allowed = new Set<string>(parseAllowedOrigins(process.env.ALLOWED_ORIGINS));
  const host = req.headers.host;
  if (host) {
    try {
      allowed.add(new URL(`${req.protocol}://${host}`).origin);
    } catch {
      // malformed Host — nothing to add
    }
  }
  if (env.trustProxy) {
    const forwardedHost = (req.headers["x-forwarded-host"] ?? "").toString().split(",")[0]?.trim();
    const forwardedProto = (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0]?.trim();
    if (forwardedHost) {
      try {
        allowed.add(new URL(`${forwardedProto || req.protocol}://${forwardedHost}`).origin);
      } catch {
        // malformed forwarded header — nothing to add
      }
    }
  }

  if (!allowed.has(originValue)) {
    throw Object.assign(new Error("Cross-origin request rejected."), { statusCode: 403 });
  }
}

/** Revoke every session of a profile (used by profile deletion). */
export async function revokeSessionsFor(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<void> {
  await db.userSession.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
}

/**
 * Hosted bound on concurrent sessions per profile (env:
 * HOSTED_MAX_SESSIONS_PER_PROFILE, default 10). Called BEFORE inserting a
 * new session: the stalest active sessions (by last-seen) are revoked to
 * make room, so a runaway session farm cannot accumulate and legit recent
 * devices stay alive. New-session wins over stale ones by construction.
 */
export async function enforceSessionCap(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<void> {
  const cap = env.hosted.maxSessionsPerProfile;
  const active = await db.userSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastSeenAt: "asc" },
    select: { id: true },
  });
  // After adding the incoming session there must be at most `cap`.
  const excess = active.length - (cap - 1);
  if (excess <= 0) return;
  const stalest = active.slice(0, excess);
  await db.userSession.updateMany({
    where: { id: { in: stalest.map((s) => s.id) } },
    data: { revokedAt: new Date() },
  });
}

/**
 * Rebind the current browser's session to another profile (identity conflict
 * flow). The token is rotated: the session now points at a different
 * profile's data, so the old token value must not stay valid.
 */
export async function rebindCurrentSession(req: FastifyRequest, reply: FastifyReply, db: ReturnType<typeof getPrismaClient>, newUserId: string): Promise<void> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return;
  const session = await db.userSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session || session.revokedAt) return;
  const fresh = newSessionToken();
  await db.userSession.update({
    where: { id: session.id },
    data: { userId: newUserId, tokenHash: hashToken(fresh), lastSeenAt: new Date() },
  });
  reply.header("Set-Cookie", serializeSessionCookie(fresh, requestIsSecure(req), SESSION_TTL_SECONDS));
}
