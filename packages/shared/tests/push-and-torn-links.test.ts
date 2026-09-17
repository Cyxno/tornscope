import { describe, expect, it } from "vitest";
import { classifyPushSendOutcome, providerRejectionReason, TORN_URLS, TORN_LINK_ATTRS, safeTornUrl } from "@tornscope/shared";

/**
 * 1.0.3 push delivery + Torn destination contracts.
 *
 * Delivery: the provider's HTTP status decides the outcome. The 1.0.3
 * production finding: Apple answers 403 BadJwtToken (bad VAPID subject) —
 * a SERVER-CONFIG rejection. It must classify as "rejected" so the (valid)
 * subscription is never revoked, unlike 404/410 which mean the subscription
 * is truly gone.
 */
describe("classifyPushSendOutcome", () => {
  it("404/410 → gone (revoke the subscription)", () => {
    expect(classifyPushSendOutcome(404)).toBe("gone");
    expect(classifyPushSendOutcome(410)).toBe("gone");
  });

  it("429 → rate-limited (retry, never revoke)", () => {
    expect(classifyPushSendOutcome(429)).toBe("rate-limited");
  });

  it("401/403 → rejected (server config; never revoke)", () => {
    expect(classifyPushSendOutcome(401)).toBe("rejected");
    expect(classifyPushSendOutcome(403)).toBe("rejected");
  });

  it("no/unknown status → network-error (retry, never revoke)", () => {
    expect(classifyPushSendOutcome(undefined)).toBe("network-error");
    expect(classifyPushSendOutcome(500)).toBe("network-error");
    expect(classifyPushSendOutcome(400)).toBe("network-error");
  });
});

describe("providerRejectionReason", () => {
  it("extracts the reason field from Apple/autopush JSON bodies", () => {
    expect(providerRejectionReason('{"reason":"BadJwtToken"}')).toBe("BadJwtToken");
  });

  it("returns null for non-JSON, oversize or reasonless bodies", () => {
    expect(providerRejectionReason("not json")).toBeNull();
    expect(providerRejectionReason("{}")).toBeNull();
    expect(providerRejectionReason(`"${"x".repeat(201)}"`)).toBeNull();
    expect(providerRejectionReason(undefined)).toBeNull();
  });
});

/**
 * Overview live-status actions point at TORN.COM (players act in Torn);
 * TornScope routes stay as explicit secondary history links. All external
 * URLs come from the audited TORN_URLS map.
 */
describe("Torn destinations", () => {
  it("covers every actionable live-status destination", () => {
    expect(TORN_URLS.travel).toBe("https://www.torn.com/page.php?sid=travel");
    expect(TORN_URLS.organizedCrime).toBe("https://www.torn.com/factions.php?step=your&type=1#/tab=crimes");
    expect(TORN_URLS.education).toBe("https://www.torn.com/education.php");
    expect(TORN_URLS.bank).toBe("https://www.torn.com/bank.php");
    expect(TORN_URLS.gym).toBe("https://www.torn.com/gym.php");
    expect(TORN_URLS.crimes).toBe("https://www.torn.com/page.php?sid=crimes");
    expect(TORN_URLS.items).toBe("https://www.torn.com/item.php");
    expect(TORN_URLS.hospital).toBe("https://www.torn.com/hospital.php");
    expect(TORN_URLS.jail).toBe("https://www.torn.com/jail.php");
  });

  it("every mapped destination is a guarded https://www.torn.com URL", () => {
    for (const url of Object.values(TORN_URLS)) {
      expect(safeTornUrl(url), url).toBe(url);
    }
  });

  it("safeTornUrl refuses off-domain schemes/hosts", () => {
    expect(safeTornUrl("http://www.torn.com/page.php")).toBeNull();
    expect(safeTornUrl("https://evil.example.com/page.php")).toBeNull();
    expect(safeTornUrl("https://torn.com.evil.com/")).toBeNull();
    expect(safeTornUrl("javascript:alert(1)")).toBeNull();
    expect(safeTornUrl("")).toBeNull();
  });

  it("external links open safely (new tab, no reverse reference)", () => {
    expect(TORN_LINK_ATTRS.target).toBe("_blank");
    expect(TORN_LINK_ATTRS.rel).toContain("noopener");
    expect(TORN_LINK_ATTRS.rel).toContain("noreferrer");
  });
});
