import { describe, expect, it } from "vitest";
import { checkPushEndpoint } from "../src/push-endpoint.js";

/**
 * Push-endpoint validation (SSRF guard) — pure unit tests, no DB needed.
 *
 * Real browsers subscribe ONLY on major push services (FCM, Mozilla, Apple,
 * WNS): HTTPS, port 443, public FQDNs. The validator must accept every such
 * endpoint while rejecting the ones that would turn the server's push sends
 * into requests at loopback, RFC1918, link-local or obviously-internal
 * hostnames.
 */

const keys = { p256dh: "p".repeat(20), auth: "a".repeat(20) };
void keys;

describe("checkPushEndpoint accepts legitimate push-service endpoints", () => {
  it("accepts a real HTTPS FCM endpoint", () => {
    expect(checkPushEndpoint("https://fcm.googleapis.com/fcm/send/abc123")).toEqual({ allowed: true });
  });

  it("accepts Mozilla's autopush endpoint", () => {
    expect(checkPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/gAAAA")).toEqual({ allowed: true });
  });

  it("accepts Apple's and Windows' push endpoints", () => {
    expect(checkPushEndpoint("https://api.push.apple.com/3/device/longtoken")).toEqual({ allowed: true });
    expect(checkPushEndpoint("https://wns2-by3p.notify.windows.com/?token=xyz")).toEqual({ allowed: true });
  });

  it("accepts a public HTTPS endpoint with an explicit :443 and a trailing-dot FQDN", () => {
    expect(checkPushEndpoint("https://push.some-provider.example:443/queue")).toEqual({ allowed: true });
    expect(checkPushEndpoint("https://push.some-provider.example./queue")).toEqual({ allowed: true });
  });
});

describe("checkPushEndpoint rejects non-HTTPS and non-standard URLs", () => {
  it("rejects plain http", () => {
    expect(checkPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toMatchObject({ allowed: false });
  });

  it("rejects non-URL garbage", () => {
    expect(checkPushEndpoint("not-a-url")).toMatchObject({ allowed: false });
  });

  it("rejects non-443 ports (internal service probing)", () => {
    expect(checkPushEndpoint("https://push.example.com:8443/queue")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://10.0.0.9:8080/x")).toMatchObject({ allowed: false });
  });

  it("rejects embedded credentials", () => {
    expect(checkPushEndpoint("https://user:pass@fcm.googleapis.com/fcm/send/x")).toMatchObject({ allowed: false });
  });
});

describe("checkPushEndpoint rejects local/private targets", () => {
  it("rejects localhost", () => {
    expect(checkPushEndpoint("https://localhost/fcm")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://LOCALHOST./fcm")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://db.localhost/push")).toMatchObject({ allowed: false });
  });

  it("rejects loopback IPv4", () => {
    expect(checkPushEndpoint("https://127.0.0.1/push")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://127.8.8.8/push")).toMatchObject({ allowed: false });
  });

  it("rejects loopback and unspecified IPv6", () => {
    expect(checkPushEndpoint("https://[::1]/push")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://[::]/push")).toMatchObject({ allowed: false });
  });

  it("rejects RFC1918 IPv4 ranges", () => {
    for (const host of ["10.1.2.3", "172.16.0.9", "172.31.255.1", "192.168.1.1"]) {
      expect(checkPushEndpoint(`https://${host}/push`), host).toMatchObject({ allowed: false });
    }
  });

  it("rejects link-local IPv4 (incl. cloud metadata) and IPv6", () => {
    expect(checkPushEndpoint("https://169.254.169.254/latest/meta-data")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://[fe80::1]/push")).toMatchObject({ allowed: false });
  });

  it("rejects IPv4-mapped and unique-local IPv6", () => {
    expect(checkPushEndpoint("https://[::ffff:127.0.0.1]/push")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://[::ffff:10.0.0.1]/push")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://[fd00::1]/push")).toMatchObject({ allowed: false });
  });

  it("rejects obvious internal-only hostnames without over-blocking public ones", () => {
    expect(checkPushEndpoint("https://intranet/push")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://push.internal/x")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://nas.lan/x")).toMatchObject({ allowed: false });
    expect(checkPushEndpoint("https://router.home.arpa/x")).toMatchObject({ allowed: false });
    // public single-part TLD-style hosts still pass
    expect(checkPushEndpoint("https://push.example.com/x")).toEqual({ allowed: true });
  });

  it("does not block a public IPv4 literal", () => {
    expect(checkPushEndpoint("https://1.2.3.4/push")).toEqual({ allowed: true });
  });
});
