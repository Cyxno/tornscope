import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getPrismaClient } from "@tornscope/database";
import { env } from "./env.js";
import { AppError } from "./errors.js";

/**
 * Browser-bound anonymous identity.
 *
 * - The browser holds ONLY an opaque random token in an HttpOnly cookie.
 * - The server stores the token's SHA-256 hash in UserSession, pointing at
 *   the profile (User row) the browser is bound to.
 * - A browser without a valid session gets a fresh anonymous profile — it
 *   never falls back to the legacy owner. The legacy owner is reachable only
 *   through the one-time bind flow (bindLegacyOwner) guarded by
 *   OWNER_BIND_TOKEN.
 * - The demo-view flag is per profile; it applies only when the profile has
 *   no active API credential.
 */

export const SESSION_COOKIE = "ts_session";
const SESSION_TTL_SECONDS = 365 * 24 * 3600;
const DEMO_VIEW_KEY = "demo_view";
const OWNER_BOUND_KEY = "owner_bound";

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

export function requestIsSecure(req: FastifyRequest): boolean {
  if (!env.trustProxy) return req.protocol === "https";
  const proto = (req.headers["x-forwarded-proto"] ?? req.protocol ?? "").toString().toLowerCase();
  return proto.split(",")[0]!.trim() === "https";
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
  const user = session.user;
  if (!user) return null;

  // Per-profile demo view: applies only while the profile has no active API
  // credential, so a connected key always wins over the demo toggle.
  const [flag, credential] = await Promise.all([
    db.appSetting.findUnique({ where: { userId_key: { userId: user.id, key: DEMO_VIEW_KEY } } }),
    db.apiCredential.findUnique({ where: { userId: user.id }, select: { revokedAt: true } }),
  ]);
  if (flag && !credential?.revokedAt) {
    // Remember which REAL profile owns the session so leaving demo mode can
    // clear ITS flag (the resolved user is now the demo profile).
    if (req) (req as unknown as { sessionProfileId?: string }).sessionProfileId = user.id;
    const demo = await db.user.findUnique({ where: { email: "demo@tornscope.local" } });
    if (demo) return demo;
  }
  return user;
}

/** Max NEW anonymous profiles one IP may create per hour (session abuse guard). */
const PROFILE_CREATION_LIMIT = 20;
const profileCreationHits = new Map<string, number[]>();

export class ProfileCreationRateLimited extends Error {
  readonly statusCode = 429;
  constructor() {
    super("Too many new sessions from this address — try again later.");
  }
}

/** Create a fresh anonymous profile + session and set the cookie. */
async function createAnonymousSession(db: ReturnType<typeof getPrismaClient>, req: FastifyRequest, reply: FastifyReply): Promise<SessionUser> {
  // Session-abuse guard: bots hammering the API without cookies must not be
  // able to grow the users table unbounded. Existing valid sessions are
  // unaffected — this only gates NEW profile creation.
  const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()) ?? req.ip ?? "unknown";
  const now = Date.now();
  const hits = (profileCreationHits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  if (hits.length >= PROFILE_CREATION_LIMIT) {
    throw new ProfileCreationRateLimited();
  }
  hits.push(now);
  profileCreationHits.set(ip, hits);
  const suffix = randomBytes(3).toString("hex");
  const user = await db.user.create({ data: { displayName: `Guest ${suffix}`, role: "user" } });
  const token = newSessionToken();
  await db.userSession.create({ data: { userId: user.id, tokenHash: hashToken(token) } });
  reply.header("Set-Cookie", serializeSessionCookie(token, requestIsSecure(req), SESSION_TTL_SECONDS));
  (req as unknown as { sessionProfileId?: string }).sessionProfileId = user.id;
  return user;
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

/** Constant-time string compare for secrets. */
function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * One-time legacy owner binding. The token lives in OWNER_BIND_TOKEN (server
 * env); the first successful bind permanently marks the owner as claimed so
 * a later token leak cannot re-bind or hand the profile to a stranger.
 */
export async function bindLegacyOwner(req: FastifyRequest, reply: FastifyReply, token: string): Promise<SessionUser> {
  const db = getPrismaClient();
  if (process.env.OWNER_BIND_ENABLED === "false" || !env.ownerBindEnabled) {
    throw new AppError("bind_disabled", "Owner binding has been disabled on this server.", 403);
  }
  const bindToken = process.env.OWNER_BIND_TOKEN ?? "";
  const recoveryToken = process.env.OWNER_RECOVERY_TOKEN ?? "";
  // The supplied token must match exactly ONE of the configured secrets;
  // neither secret nor which one failed is disclosed.
  const isBind = bindToken !== "" && safeEquals(token, bindToken);
  const isRecovery = recoveryToken !== "" && safeEquals(token, recoveryToken);
  if (!isBind && !isRecovery) throw new AppError("bind_invalid_token", "Invalid binding token.", 403);

  const owner = await db.user.findFirst({ where: { role: "owner", isDemo: false }, orderBy: { createdAt: "asc" } });
  if (!owner) throw new AppError("bind_no_owner", "No legacy owner profile exists.", 404);

  const already = await db.appSetting.findUnique({ where: { userId_key: { userId: owner.id, key: OWNER_BOUND_KEY } } });
  const recoveryMode = Boolean(already) && isRecovery;
  if (already && !recoveryMode) {
    throw new AppError("bind_already_claimed", "The legacy owner profile has already been bound to a browser.", 409);
  }

  // Bind: point the current browser's session at the owner profile. In
  // recovery mode, prior active owner sessions are revoked first so a stale
  // or leaked browser session cannot share the profile silently. Works even
  // when the browser has NO valid session (dead/stale cookie): a new session
  // bound to the owner is created here — the secret token is the only gate,
  // which is why the route itself is rate-limited.
  if (recoveryMode) {
    await db.userSession.updateMany({ where: { userId: owner.id, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  const cookies = parseCookies(req.headers.cookie);
  const existingToken = cookies[SESSION_COOKIE];
  const fresh = newSessionToken();
  let bound = false;
  if (existingToken) {
    const session = await db.userSession.findUnique({ where: { tokenHash: hashToken(existingToken) } });
    if (session && !session.revokedAt) {
      await db.userSession.update({ where: { id: session.id }, data: { userId: owner.id } });
      bound = true;
    }
  }
  if (!bound) {
    await db.userSession.create({ data: { userId: owner.id, tokenHash: hashToken(fresh) } });
    reply.header("Set-Cookie", serializeSessionCookie(fresh, requestIsSecure(req), SESSION_TTL_SECONDS));
  }

  if (!already) {
    await db.appSetting.create({ data: { userId: owner.id, key: OWNER_BOUND_KEY, value: true } });
  }
  (req as unknown as { sessionProfileId?: string }).sessionProfileId = owner.id;
  return owner;
}

/** Whether the bind flow is still possible (token configured + not claimed). */
/**
 * Whether the LEGACY OWNER RECOVERY/BINDING section is meaningful for the
 * given viewer: it is hidden from the owner themselves (nothing to restore)
 * and shown to everyone else only while a token is configured server-side.
 */
export async function ownerBindAvailableFor(viewerUserId: string): Promise<boolean> {
  if (!env.ownerBindEnabled) return false;
  const recoveryConfigured = Boolean(process.env.OWNER_RECOVERY_TOKEN);
  const bindOpen = Boolean(process.env.OWNER_BIND_TOKEN);
  if (!bindOpen && !recoveryConfigured) return false;
  const db = getPrismaClient();
  const owner = await db.user.findFirst({ where: { role: "owner", isDemo: false }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!owner) return false;
  if (viewerUserId === owner.id) return false; // the owner needs no recovery
  const bound = await db.appSetting.findUnique({ where: { userId_key: { userId: owner.id, key: OWNER_BOUND_KEY } } });
  return !bound || recoveryConfigured;
}

/**
 * CSRF defense for cookie-authenticated mutations: browsers attach an Origin
 * header on cross-site requests, so a mismatched Origin is rejected.
 * SameSite=Lax is the first layer; this is the second.
 *
 * The API always sits behind the web app's same-origin proxy: the proxy keeps
 * the browser's Origin header but rewrites Host to the internal `api:3000`.
 * With TRUST_PROXY (default), the forwarded host is the real browser-facing
 * host and is accepted alongside Host. A cross-SITE attacker's page still
 * fails both — its Origin is evil.com, while x-forwarded-host is set by our
 * proxy, never by the attacker.
 */
export function assertSameOrigin(req: FastifyRequest): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.origin;
  if (!origin) return; // non-browser client (curl / server-to-server)
  const allowed = new Set<string>();
  const host = req.headers.host;
  if (host) allowed.add(host);
  if (env.trustProxy) {
    const forwardedHost = (req.headers["x-forwarded-host"] ?? "").toString().split(",")[0]?.trim();
    if (forwardedHost) allowed.add(forwardedHost);
  }
  for (const extra of (process.env.ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) {
      try {
        allowed.add(new URL(trimmed).host);
      } catch {
        // ignore malformed entries
      }
    }
  }
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = "";
  }
  if (!originHost || !allowed.has(originHost)) {
    throw Object.assign(new Error("Cross-origin request rejected."), { statusCode: 403 });
  }
}

/** Revoke every session of a profile (used by profile deletion). */
export async function revokeSessionsFor(db: ReturnType<typeof getPrismaClient>, userId: string): Promise<void> {
  await db.userSession.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
}

/** Rebind the current browser's session to another profile (identity conflict flow). */
export async function rebindCurrentSession(req: FastifyRequest, db: ReturnType<typeof getPrismaClient>, newUserId: string): Promise<void> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return;
  const session = await db.userSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session || session.revokedAt) return;
  await db.userSession.update({ where: { id: session.id }, data: { userId: newUserId } });
}
