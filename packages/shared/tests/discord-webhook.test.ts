import { describe, expect, it, vi } from "vitest";
import {
  buildDiscordContent,
  buildDiscordPayload,
  DISCORD_MAX_CONTENT_CHARS,
  isTransientDiscordError,
  maskedWebhookPreview,
  sendDiscordWebhook,
  validateDiscordWebhookUrl,
} from "../src/discord.js";

/**
 * Discord webhook validation + delivery contract. NO test ever performs a
 * real HTTP request: fetchImpl is always a mock.
 */

const VALID = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij";

describe("validateDiscordWebhookUrl (SSRF guard)", () => {
  it("accepts official Discord webhook hosts with the exact path shape", () => {
    expect(validateDiscordWebhookUrl(VALID)).toEqual({ ok: true, webhookId: "123456789012345678" });
    expect(validateDiscordWebhookUrl(VALID.replace("discord.com", "discordapp.com")).ok).toBe(true);
    expect(validateDiscordWebhookUrl(VALID.replace("discord.com", "ptb.discord.com")).ok).toBe(true);
    expect(validateDiscordWebhookUrl(VALID.replace("discord.com", "canary.discord.com")).ok).toBe(true);
    expect(validateDiscordWebhookUrl("https://discord.com/api/v10/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij").ok).toBe(true);
  });

  it("rejects non-HTTPS and userinfo tricks", () => {
    expect(validateDiscordWebhookUrl(VALID.replace("https://", "http://")).reason).toBe("insecure_scheme");
    expect(validateDiscordWebhookUrl("https://user:pass@discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij").reason).toBe("invalid_url");
  });

  it("rejects arbitrary hosts (loopback, internal, look-alikes)", () => {
    const swap = (host: string) => VALID.replace("discord.com", host);
    expect(validateDiscordWebhookUrl(swap("evil.example")).reason).toBe("unsupported_host");
    expect(validateDiscordWebhookUrl(swap("127.0.0.1")).reason).toBe("unsupported_host");
    expect(validateDiscordWebhookUrl(swap("discord.com.evil.example")).reason).toBe("unsupported_host");
    expect(validateDiscordWebhookUrl(swap("discord-com"))).toMatchObject({ ok: false });
    expect(validateDiscordWebhookUrl(VALID.replace("discord.com", "discord.com:8443")).reason).toBe("unsupported_host");
  });

  it("rejects wrong paths, query strings and garbage", () => {
    expect(validateDiscordWebhookUrl("https://discord.com/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij").reason).toBe("bad_path");
    expect(validateDiscordWebhookUrl(`${VALID}?wait=true`).reason).toBe("bad_path");
    expect(validateDiscordWebhookUrl(`${VALID}/extra`).reason).toBe("bad_path");
    expect(validateDiscordWebhookUrl("not a url").reason).toBe("invalid_url");
    expect(validateDiscordWebhookUrl("https://discord.com/api/webhooks/abc/tooshort").reason).toBe("bad_path");
  });
});

describe("maskedWebhookPreview", () => {
  it("never exposes the token", () => {
    const preview = maskedWebhookPreview(VALID);
    expect(preview).toContain("discord.com/api/webhooks");
    expect(preview).toContain("••••");
    expect(preview).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(preview).not.toBe(VALID);
  });
});

describe("buildDiscordContent / buildDiscordPayload", () => {
  it("joins title and message and hard-caps at Discord's 2000-char limit", () => {
    const long = "x".repeat(3000);
    const content = buildDiscordContent({ title: "T", message: long });
    expect(content.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT_CHARS);
    expect(content.startsWith("**T**")).toBe(true);
    expect(content.endsWith("…")).toBe(true);
  });

  it("disables all mentions at the payload level", () => {
    const payload = buildDiscordPayload("**T**\nhello @everyone");
    expect(payload).toMatchObject({ content: expect.stringContaining("hello"), username: "TornScope" });
    expect((payload.allowed_mentions as { parse: string[] }).parse).toEqual([]);
  });
});

describe("sendDiscordWebhook (mocked fetch — never real HTTP)", () => {
  const opts = { timeoutMs: 8000 };

  function fetchReturning(status: number, body?: unknown, headers?: Record<string, string>): typeof fetch {
    return vi.fn(async () =>
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers })
    ) as unknown as typeof fetch;
  }

  it("2xx is the ONLY sent outcome", async () => {
    const f = fetchReturning(204);
    await expect(sendDiscordWebhook(VALID, "hello", { ...opts, fetchImpl: f })).resolves.toEqual({ outcome: "sent" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("429 carries Discord's retry_after (bounded, seconds)", async () => {
    const f = fetchReturning(429, { retry_after: 2.5 });
    const result = await sendDiscordWebhook(VALID, "hello", { ...opts, fetchImpl: f });
    expect(result).toMatchObject({ outcome: "rate_limited", retryAfterSec: 3 });
  });

  it("401/403/404/410/400 are permanent, never retried", async () => {
    for (const status of [401, 403, 404, 410, 400]) {
      const result = await sendDiscordWebhook(VALID, "hello", { ...opts, fetchImpl: fetchReturning(status) });
      expect(result).toMatchObject({ outcome: "failed", errorKind: "invalid_webhook" });
    }
  });

  it("5xx is transient; error messages never contain the URL or token", async () => {
    const result = await sendDiscordWebhook(VALID, "hello", { ...opts, fetchImpl: fetchReturning(503) });
    expect(result).toMatchObject({ outcome: "failed", errorKind: "transient" });
    expect(JSON.stringify(result)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(JSON.stringify(result)).not.toContain("discord.com");
  });

  it("redirects are REFUSED (they cannot bypass host validation)", async () => {
    const result = await sendDiscordWebhook(VALID, "hello", { ...opts, fetchImpl: fetchReturning(302) });
    expect(result).toMatchObject({ outcome: "failed", errorKind: "redirect" });
  });

  it("network errors and timeouts are transient with sanitized messages", async () => {
    const networkError = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(sendDiscordWebhook(VALID, "x", { ...opts, fetchImpl: networkError })).resolves.toMatchObject({
      outcome: "failed",
      errorKind: "transient",
    });
    const timeout = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(sendDiscordWebhook(VALID, "x", { ...opts, fetchImpl: timeout })).resolves.toMatchObject({
      outcome: "failed",
      errorKind: "timeout",
    });
  });

  it("rejects invalid targets locally before any request exists", async () => {
    const f = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const result = await sendDiscordWebhook("https://evil.example/hook", "x", { ...opts, fetchImpl: f });
    expect(result).toMatchObject({ outcome: "failed", errorKind: "invalid_webhook" });
    expect(f).not.toHaveBeenCalled();
  });

  it("classifies retryable kinds", () => {
    expect(isTransientDiscordError("rate_limited")).toBe(true);
    expect(isTransientDiscordError("transient")).toBe(true);
    expect(isTransientDiscordError("timeout")).toBe(true);
    expect(isTransientDiscordError("invalid_webhook")).toBe(false);
    expect(isTransientDiscordError("redirect")).toBe(false);
  });
});
