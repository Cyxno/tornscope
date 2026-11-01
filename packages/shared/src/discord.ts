/**
 * Discord webhook delivery (SSRF-guarded).
 *
 * A Discord webhook URL is BOTH a secret (it embeds the write token) and an
 * arbitrary attacker-supplied URL: stored targets are AES-256-GCM encrypted
 * at rest and validated structurally here — HTTPS, an approved Discord
 * webhook host, and the exact /api/webhooks/{id}/{token} path shape. A URL
 * pointing anywhere else (loopback, RFC1918, cloud metadata, other sites) is
 * rejected BEFORE any request exists.
 *
 * Redirection is refused: fetch runs with redirect:"manual" and any 3xx is a
 * delivery failure, so a redirect can never bypass host validation.
 *
 * Error classification is the delivery contract:
 *   sent            — 2xx: Discord ACCEPTED the payload (the only "sent").
 *   rate_limited    — 429: retry later per the returned retry_after.
 *   invalid_webhook — 401/403/404/410/400: permanent, never retried.
 *   transient       — 5xx / network / timeout: bounded retry with backoff.
 *   redirect        — 3xx: refused (permanent for this attempt cycle).
 * Error messages and logs never contain the URL or token.
 */

/** Hosts Discord actually serves webhook endpoints on. */
export const DISCORD_WEBHOOK_HOSTS = ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"] as const;

/** Path shape: /api (optionally versioned) /webhooks/{numeric id}/{token}. */
const WEBHOOK_PATH_PATTERN = /^\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,})$/;

/** Hard cap from Discord: messages longer than this are rejected (400). */
export const DISCORD_MAX_CONTENT_CHARS = 2000;

export type DiscordWebhookValidation =
  | { ok: true; webhookId: string }
  | { ok: false; reason: "invalid_url" | "insecure_scheme" | "unsupported_host" | "bad_path" };

/** Structural validation — purely local, no DNS, no network. */
export function validateDiscordWebhookUrl(rawUrl: string): DiscordWebhookValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "insecure_scheme" };
  if (url.username || url.password) return { ok: false, reason: "invalid_url" };
  if (url.port) return { ok: false, reason: "unsupported_host" };
  if (!(DISCORD_WEBHOOK_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: "unsupported_host" };
  }
  if (url.search || url.hash) return { ok: false, reason: "bad_path" };
  const match = WEBHOOK_PATH_PATTERN.exec(url.pathname);
  if (!match) return { ok: false, reason: "bad_path" };
  return { ok: true, webhookId: match[1]! };
}

/** Masked target for UI/logs — host + id prefix only, NEVER the token. */
export function maskedWebhookPreview(rawUrl: string): string {
  const validation = validateDiscordWebhookUrl(rawUrl);
  if (!validation.ok) return "invalid webhook target";
  return `discord.com/api/webhooks/${validation.webhookId.slice(0, 4)}…/••••`;
}

/**
 * Build the message content. Untrusted, user-derived text (titles contain
 * Torn data) is plain text in the content field — Discord does not interpret
 * markdown-adjacent characters unsafely, but every mention is suppressed at
 * the payload level (allowed_mentions parse:[]) and lone "@" lines cannot
 * ping anyone. Content is hard-truncated to Discord's 2000-char limit.
 */
export function buildDiscordContent(opts: { title: string; message: string; suffix?: string }): string {
  const parts = [`**${opts.title}**`, opts.message];
  if (opts.suffix) parts.push(opts.suffix);
  const joined = parts.filter((p) => p && p.trim() !== "").join("\n");
  if (joined.length <= DISCORD_MAX_CONTENT_CHARS) return joined;
  return `${joined.slice(0, DISCORD_MAX_CONTENT_CHARS - 1)}…`;
}

/** The exact JSON payload sent to Discord (mentions fully disabled). */
export function buildDiscordPayload(content: string, username = "TornScope"): Record<string, unknown> {
  return {
    content,
    username,
    allowed_mentions: { parse: [] as string[] },
  };
}

export const DISCORD_ERROR_KINDS = [
  "invalid_webhook",
  "rate_limited",
  "transient",
  "timeout",
  "redirect",
  "http_error",
  "disabled",
] as const;
export type DiscordErrorKind = (typeof DISCORD_ERROR_KINDS)[number];

/** True when the error kind may succeed on a later attempt. */
export function isTransientDiscordError(kind: DiscordErrorKind): boolean {
  return kind === "rate_limited" || kind === "transient" || kind === "timeout";
}

export type DiscordSendResult =
  | { outcome: "sent" }
  | { outcome: "rate_limited"; retryAfterSec: number }
  | { outcome: "failed"; errorKind: DiscordErrorKind; /** Sanitized — never includes the URL/token. */ message: string };

/**
 * POST one webhook message. `fetchImpl` is injectable for tests; production
 * resolves to global fetch. The URL is used ONLY for the request — it never
 * appears in a returned error or a thrown one.
 */
export async function sendDiscordWebhook(
  webhookUrl: string,
  content: string,
  opts: { timeoutMs: number; fetchImpl?: typeof fetch; username?: string }
): Promise<DiscordSendResult> {
  const validation = validateDiscordWebhookUrl(webhookUrl);
  if (!validation.ok) {
    return { outcome: "failed", errorKind: "invalid_webhook", message: `Webhook target rejected (${validation.reason}).` };
  }
  if (content.length > DISCORD_MAX_CONTENT_CHARS) {
    // buildDiscordContent already truncates; this guards direct callers.
    return { outcome: "failed", errorKind: "http_error", message: "Message exceeds the Discord length limit." };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildDiscordPayload(content, opts.username)),
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { outcome: "failed", errorKind: "timeout", message: `Webhook did not respond within ${opts.timeoutMs}ms.` };
    }
    return { outcome: "failed", errorKind: "transient", message: "Webhook could not be reached (network error)." };
  }

  // Redirects are REFUSED: following one could bypass host validation. Discord
  // does not redirect webhook executions — any 3xx means the target changed.
  if (res.status >= 300 && res.status < 400) {
    return { outcome: "failed", errorKind: "redirect", message: `Webhook responded with redirect ${res.status} — refused.` };
  }

  if (res.ok) return { outcome: "sent" };

  if (res.status === 429) {
    const retryAfterSec = await discordRetryAfterSeconds(res);
    return { outcome: "rate_limited", retryAfterSec };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
    return { outcome: "failed", errorKind: "invalid_webhook", message: `Webhook rejected by Discord (HTTP ${res.status}). The URL may be revoked or wrong.` };
  }
  if (res.status === 400) {
    return { outcome: "failed", errorKind: "invalid_webhook", message: "Discord rejected the message payload (HTTP 400)." };
  }
  if (res.status >= 500) {
    return { outcome: "failed", errorKind: "transient", message: `Discord server error (HTTP ${res.status}).` };
  }
  return { outcome: "failed", errorKind: "http_error", message: `Webhook request failed (HTTP ${res.status}).` };
}

/** Discord signals the wait either in the JSON body (`retry_after`, seconds,
 *  may be fractional) or the Retry-After header (milliseconds per its docs;
 *  seconds in practice). Bounded to a sane 1h. */
async function discordRetryAfterSeconds(res: Response): Promise<number> {
  let retryAfterSec = 5;
  try {
    const body = (await res.json()) as { retry_after?: unknown };
    if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after) && body.retry_after >= 0) {
      retryAfterSec = body.retry_after;
    }
  } catch {
    const header = res.headers.get("retry-after");
    const parsed = header ? Number(header) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) retryAfterSec = parsed > 1000 ? parsed / 1000 : parsed;
  }
  return Math.min(3600, Math.max(1, Math.ceil(retryAfterSec)));
}
